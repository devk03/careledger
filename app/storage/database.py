import hashlib
import os
import sqlite3
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from importlib import resources
from pathlib import Path
from uuid import uuid4

APPLICATION_ID = 1_129_071_687  # ASCII "CLDG"
CURRENT_SCHEMA_VERSION = 4
BUSY_TIMEOUT_MS = 5_000


class SchemaErrorCode(StrEnum):
    INVALID_DATABASE = "INVALID_DATABASE"
    UNKNOWN_SCHEMA = "UNKNOWN_SCHEMA"
    NEWER_SCHEMA = "NEWER_SCHEMA"
    APPLICATION_ID_MISMATCH = "APPLICATION_ID_MISMATCH"
    MIGRATION_HASH_MISMATCH = "MIGRATION_HASH_MISMATCH"
    INTEGRITY_CHECK_FAILED = "INTEGRITY_CHECK_FAILED"
    FOREIGN_KEY_CHECK_FAILED = "FOREIGN_KEY_CHECK_FAILED"


class SchemaError(RuntimeError):
    def __init__(self, code: SchemaErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    resource_name: str

    def sql(self) -> str:
        return (
            resources.files("app.storage.migrations")
            .joinpath(self.resource_name)
            .read_text(encoding="utf-8")
        )

    def sha256(self) -> str:
        return hashlib.sha256(self.sql().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class SchemaStatus:
    version: int
    application_id: int
    migration_count: int


MIGRATIONS = (
    Migration(1, "initial", "0001_initial.sql"),
    Migration(2, "cross_scope_guards", "0002_cross_scope_guards.sql"),
    Migration(3, "extraction_job_uniqueness", "0003_extraction_job_uniqueness.sql"),
    Migration(4, "workflow_actor_guards", "0004_workflow_actor_guards.sql"),
)


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> SchemaStatus:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise SchemaError(SchemaErrorCode.INVALID_DATABASE)
        if not self.path.exists():
            self._initialize_new_database()
        with self.connect() as connection:
            self._apply_pending(connection)
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA wal_autocheckpoint = 1000")
            return self._verify(connection)

    @contextmanager
    def connect(self, *, read_only: bool = False) -> Iterator[sqlite3.Connection]:
        if read_only:
            uri = f"{self.path.resolve().as_uri()}?mode=ro"
            connection = sqlite3.connect(
                uri,
                uri=True,
                isolation_level=None,
                timeout=BUSY_TIMEOUT_MS / 1000,
            )
        else:
            connection = sqlite3.connect(
                self.path,
                isolation_level=None,
                timeout=BUSY_TIMEOUT_MS / 1000,
            )
        connection.row_factory = sqlite3.Row
        try:
            self._configure(connection, read_only=read_only)
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
            except Exception:
                connection.rollback()
                raise
            else:
                connection.commit()

    def verify(self) -> SchemaStatus:
        with self.connect(read_only=True) as connection:
            return self._verify(connection)

    def is_setup_complete(self) -> bool:
        with self.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT setup_completed_at FROM app_state WHERE singleton = 1"
            ).fetchone()
            owner = connection.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active'"
            ).fetchone()
        if row is None or owner is None:
            raise SchemaError(SchemaErrorCode.INTEGRITY_CHECK_FAILED)
        completed = row["setup_completed_at"] is not None
        owner_exists = owner[0] == 1
        if completed != owner_exists:
            raise SchemaError(SchemaErrorCode.INTEGRITY_CHECK_FAILED)
        return completed

    def _initialize_new_database(self) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".careledger-initialize-",
            suffix=".sqlite",
            dir=self.path.parent,
        )
        os.close(descriptor)
        temporary_path = Path(temporary_name)
        try:
            connection = sqlite3.connect(temporary_path, isolation_level=None)
            connection.row_factory = sqlite3.Row
            try:
                self._configure(connection, read_only=False)
                self._apply_pending(connection)
                self._verify(connection)
            finally:
                connection.close()
            temporary_path.chmod(0o600)
            os.replace(temporary_path, self.path)
            self.path.chmod(0o600)
            _fsync_directory(self.path.parent)
        except Exception:
            if temporary_path.exists():
                failed_path = self.path.parent / f"migration-failed-{uuid4()}.sqlite"
                os.replace(temporary_path, failed_path)
                failed_path.chmod(0o600)
                _fsync_directory(self.path.parent)
            raise

    @staticmethod
    def _configure(connection: sqlite3.Connection, *, read_only: bool) -> None:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        # Debian's SQLite 3.40 does not mark JSON1 functions innocuous, so a schema with
        # CHECK(json_valid(...)) cannot be created or written with trusted_schema disabled.
        # CareLedger accepts DDL only from checksum-verified bundled migrations.
        connection.execute("PRAGMA trusted_schema = ON")
        connection.execute("PRAGMA recursive_triggers = ON")
        if not read_only:
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute("PRAGMA secure_delete = ON")
        else:
            connection.execute("PRAGMA query_only = ON")

    def _apply_pending(self, connection: sqlite3.Connection) -> None:
        try:
            application_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
            user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        except sqlite3.DatabaseError as exc:
            raise SchemaError(SchemaErrorCode.INVALID_DATABASE) from exc
        if application_id not in {0, APPLICATION_ID}:
            raise SchemaError(SchemaErrorCode.APPLICATION_ID_MISMATCH)
        if user_version > CURRENT_SCHEMA_VERSION:
            raise SchemaError(SchemaErrorCode.NEWER_SCHEMA)
        user_tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        if user_version == 0 and user_tables:
            raise SchemaError(SchemaErrorCode.UNKNOWN_SCHEMA)
        if user_version == CURRENT_SCHEMA_VERSION:
            self._verify_migration_hashes(connection)
            return

        for migration in MIGRATIONS:
            if migration.version <= user_version:
                continue
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
                for statement in _statements(migration.sql()):
                    connection.execute(statement)
                connection.execute(
                    "INSERT INTO schema_migrations "
                    "(version, name, sha256, app_version, applied_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        migration.version,
                        migration.name,
                        migration.sha256(),
                        "0.1.0",
                        _now_epoch(),
                    ),
                )
                connection.execute(f"PRAGMA user_version = {migration.version}")
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def _verify(self, connection: sqlite3.Connection) -> SchemaStatus:
        application_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
        user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if application_id != APPLICATION_ID:
            raise SchemaError(SchemaErrorCode.APPLICATION_ID_MISMATCH)
        if user_version > CURRENT_SCHEMA_VERSION:
            raise SchemaError(SchemaErrorCode.NEWER_SCHEMA)
        if user_version != CURRENT_SCHEMA_VERSION:
            raise SchemaError(SchemaErrorCode.UNKNOWN_SCHEMA)
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise SchemaError(SchemaErrorCode.INTEGRITY_CHECK_FAILED)
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise SchemaError(SchemaErrorCode.FOREIGN_KEY_CHECK_FAILED)
        self._verify_migration_hashes(connection)
        count = int(connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0])
        return SchemaStatus(
            version=user_version,
            application_id=application_id,
            migration_count=count,
        )

    @staticmethod
    def _verify_migration_hashes(connection: sqlite3.Connection) -> None:
        try:
            rows = {
                int(row["version"]): row["sha256"]
                for row in connection.execute(
                    "SELECT version, sha256 FROM schema_migrations"
                ).fetchall()
            }
        except sqlite3.DatabaseError as exc:
            raise SchemaError(SchemaErrorCode.UNKNOWN_SCHEMA) from exc
        for migration in MIGRATIONS:
            if rows.get(migration.version) != migration.sha256():
                raise SchemaError(SchemaErrorCode.MIGRATION_HASH_MISMATCH)


def _statements(sql: str) -> Iterator[str]:
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            buffer = ""
            if statement:
                yield statement
    if buffer.strip():
        raise ValueError("migration contains an incomplete SQL statement")


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
