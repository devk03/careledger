import hashlib
import os
import sqlite3
import tempfile
from pathlib import Path


def create_sqlite_snapshot(source: Path, destination: Path) -> str:
    if not source.is_file():
        raise ValueError("SQLite source does not exist")
    if destination.exists():
        raise ValueError("SQLite snapshot destination must not exist")
    if source.resolve() == destination.resolve():
        raise ValueError("SQLite snapshot destination must differ from its source")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".sqlite-snapshot-",
        dir=destination.parent,
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        source_connection = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)
        try:
            destination_connection = sqlite3.connect(temporary_path)
            try:
                source_connection.backup(destination_connection)
                result = destination_connection.execute("PRAGMA integrity_check").fetchone()
                if result is None or result[0] != "ok":
                    raise ValueError("SQLite snapshot integrity check failed")
                destination_connection.commit()
            finally:
                destination_connection.close()
        finally:
            source_connection.close()
        temporary_path.chmod(0o600)
        os.replace(temporary_path, destination)
        _fsync_directory(destination.parent)
        return _file_sha256(destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def verify_sqlite_snapshot(path: Path) -> None:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise ValueError("restored SQLite snapshot failed integrity check")
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise ValueError("restored SQLite snapshot failed foreign-key check")
    finally:
        connection.close()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
