import os
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from app.security.audit import event_hash_v1
from app.security.bootstrap import BootstrapManager
from app.security.passwords import PasswordManager
from app.security.throttle import LoginBackoffPolicy
from app.security.tokens import (
    generate_recovery_codes,
    hash_session_token,
    issue_csrf_token,
    issue_session_token,
    verify_csrf_token,
    verify_recovery_code,
)
from app.storage.database import Database

SESSION_TTL_SECONDS = 8 * 60 * 60


class AuthErrorCode(StrEnum):
    INVALID_SETUP = "INVALID_SETUP"
    SETUP_ALREADY_COMPLETE = "SETUP_ALREADY_COMPLETE"
    SETUP_REQUIRED = "SETUP_REQUIRED"
    INVALID_CREDENTIALS = "INVALID_CREDENTIALS"
    INVALID_SESSION = "INVALID_SESSION"
    INVALID_CSRF = "INVALID_CSRF"
    TRY_LATER = "TRY_LATER"


class AuthError(RuntimeError):
    def __init__(self, code: AuthErrorCode, *, retry_after: int | None = None) -> None:
        super().__init__(code.value)
        self.code = code
        self.retry_after = retry_after


@dataclass(frozen=True)
class AuthenticatedUser:
    id: UUID
    display_name: str
    role: str


@dataclass(frozen=True)
class AuthenticatedSession:
    id: UUID
    user: AuthenticatedUser
    plaintext_token: str
    csrf_token: str
    expires_at: int
    recovery_codes: tuple[str, ...] = ()


@dataclass(frozen=True)
class SessionRecord:
    id: UUID
    household_id: UUID
    user: AuthenticatedUser
    csrf_secret: bytes
    expires_at: int


class AuthService:
    def __init__(
        self,
        database: Database,
        bootstrap: BootstrapManager,
        recovery_pepper: bytes,
        *,
        passwords: PasswordManager | None = None,
        backoff: LoginBackoffPolicy | None = None,
        session_ttl_seconds: int = SESSION_TTL_SECONDS,
    ) -> None:
        self._database = database
        self._bootstrap = bootstrap
        self._recovery_pepper = recovery_pepper
        self._passwords = passwords or PasswordManager()
        self._backoff = backoff or LoginBackoffPolicy()
        self._session_ttl_seconds = session_ttl_seconds

    def setup_owner(
        self,
        token: str,
        password: str,
        *,
        display_name: str,
        household_name: str,
        now: int | None = None,
    ) -> AuthenticatedSession:
        timestamp = now or _now_epoch()
        display_name = _required_text(display_name, maximum=120)
        household_name = _required_text(household_name, maximum=120)
        self._require_not_locked("setup", timestamp)
        if self._database.is_setup_complete():
            raise AuthError(AuthErrorCode.SETUP_ALREADY_COMPLETE)
        if not self._bootstrap.verify(token, setup_complete=False):
            retry_after = self._record_failure("setup", timestamp)
            if retry_after:
                raise AuthError(AuthErrorCode.TRY_LATER, retry_after=retry_after)
            raise AuthError(AuthErrorCode.INVALID_SETUP)

        password_hash = self._passwords.hash(password)
        issued = issue_session_token()
        session_id = uuid4()
        csrf_secret = os.urandom(32)
        household_id = uuid4()
        user_id = uuid4()
        recovery_batch_id = uuid4()
        recovery = generate_recovery_codes(self._recovery_pepper)
        expires_at = timestamp + self._session_ttl_seconds

        with self._database.transaction() as connection:
            state = connection.execute(
                "SELECT setup_completed_at FROM app_state WHERE singleton = 1"
            ).fetchone()
            owner_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active'"
                ).fetchone()[0]
            )
            if state is None or state["setup_completed_at"] is not None or owner_count:
                raise AuthError(AuthErrorCode.SETUP_ALREADY_COMPLETE)
            if not self._bootstrap.verify(token, setup_complete=False):
                raise AuthError(AuthErrorCode.INVALID_SETUP)
            connection.execute(
                "INSERT INTO households (singleton, id, display_name, created_at) "
                "VALUES (1, ?, ?, ?)",
                (str(household_id), household_name, timestamp),
            )
            connection.execute(
                "INSERT INTO users "
                "(id, household_id, login_name, login_name_normalized, display_name, role, "
                "status, password_hash, auth_version, created_at, updated_at, "
                "password_changed_at, disabled_at) "
                "VALUES (?, ?, 'owner', 'owner', ?, 'owner', 'active', ?, 1, ?, ?, ?, NULL)",
                (
                    str(user_id),
                    str(household_id),
                    display_name,
                    password_hash,
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            )
            for code_id, code_hmac in zip(
                (uuid4() for _ in recovery.hmac_sha256),
                recovery.hmac_sha256,
                strict=True,
            ):
                connection.execute(
                    "INSERT INTO recovery_codes "
                    "(id, user_id, batch_id, code_hmac, created_at, used_at, revoked_at) "
                    "VALUES (?, ?, ?, ?, ?, NULL, NULL)",
                    (
                        str(code_id),
                        str(user_id),
                        str(recovery_batch_id),
                        code_hmac,
                        timestamp,
                    ),
                )
            _insert_session(
                connection,
                session_id=session_id,
                user_id=user_id,
                token_sha256=issued.sha256,
                csrf_secret=csrf_secret,
                auth_version=1,
                created_at=timestamp,
                expires_at=expires_at,
            )
            connection.execute(
                "UPDATE app_state SET setup_completed_at = ?, active_household_id = ? "
                "WHERE singleton = 1",
                (timestamp, str(household_id)),
            )
            connection.execute(
                "INSERT INTO auth_throttles "
                "(scope, consecutive_failures, locked_until, updated_at) "
                "VALUES ('setup', 0, NULL, ?) "
                "ON CONFLICT(scope) DO UPDATE SET consecutive_failures = 0, "
                "locked_until = NULL, updated_at = excluded.updated_at",
                (timestamp,),
            )
            _append_audit(
                connection,
                household_id=str(household_id),
                actor_user_id=str(user_id),
                action="owner_setup",
                entity_kind="user",
                entity_id=str(user_id),
                outcome="success",
                occurred_at=timestamp,
            )

        self._bootstrap.complete(token, setup_complete=False)
        return AuthenticatedSession(
            id=session_id,
            user=AuthenticatedUser(id=user_id, display_name=display_name, role="owner"),
            plaintext_token=issued.plaintext,
            csrf_token=issue_csrf_token(session_id, csrf_secret),
            expires_at=expires_at,
            recovery_codes=recovery.plaintext_codes,
        )

    def login(self, password: str, *, now: int | None = None) -> AuthenticatedSession:
        timestamp = now or _now_epoch()
        if not self._database.is_setup_complete():
            raise AuthError(AuthErrorCode.SETUP_REQUIRED)
        self._require_not_locked("login", timestamp)
        with self._database.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT id, household_id, display_name, role, password_hash, auth_version "
                "FROM users WHERE role = 'owner' AND status = 'active'"
            ).fetchone()
        if row is None or row["password_hash"] is None or not self._passwords.verify(
            row["password_hash"], password
        ):
            retry_after = self._record_failure("login", timestamp)
            if retry_after:
                raise AuthError(AuthErrorCode.TRY_LATER, retry_after=retry_after)
            raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)

        expected_hash = row["password_hash"]
        replacement_hash = (
            self._passwords.hash(password) if self._passwords.needs_rehash(expected_hash) else None
        )
        issued = issue_session_token()
        session_id = uuid4()
        csrf_secret = os.urandom(32)
        expires_at = timestamp + self._session_ttl_seconds
        user_id = UUID(row["id"])
        with self._database.transaction() as connection:
            current = connection.execute(
                "SELECT password_hash, auth_version, status FROM users WHERE id = ?",
                (str(user_id),),
            ).fetchone()
            if (
                current is None
                or current["status"] != "active"
                or current["password_hash"] != expected_hash
            ):
                raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)
            if replacement_hash is not None:
                connection.execute(
                    "UPDATE users SET password_hash = ?, updated_at = ?, "
                    "password_changed_at = ? WHERE id = ?",
                    (replacement_hash, timestamp, timestamp, str(user_id)),
                )
            _insert_session(
                connection,
                session_id=session_id,
                user_id=user_id,
                token_sha256=issued.sha256,
                csrf_secret=csrf_secret,
                auth_version=int(current["auth_version"]),
                created_at=timestamp,
                expires_at=expires_at,
            )
            connection.execute(
                "INSERT INTO auth_throttles "
                "(scope, consecutive_failures, locked_until, updated_at) "
                "VALUES ('login', 0, NULL, ?) "
                "ON CONFLICT(scope) DO UPDATE SET consecutive_failures = 0, "
                "locked_until = NULL, updated_at = excluded.updated_at",
                (timestamp,),
            )
            _append_audit(
                connection,
                household_id=row["household_id"],
                actor_user_id=str(user_id),
                action="login",
                entity_kind="session",
                entity_id=str(session_id),
                outcome="success",
                occurred_at=timestamp,
            )
        return AuthenticatedSession(
            id=session_id,
            user=AuthenticatedUser(
                id=user_id,
                display_name=row["display_name"],
                role=row["role"],
            ),
            plaintext_token=issued.plaintext,
            csrf_token=issue_csrf_token(session_id, csrf_secret),
            expires_at=expires_at,
        )

    def session(self, plaintext_token: str, *, now: int | None = None) -> SessionRecord:
        timestamp = now or _now_epoch()
        token_sha256 = hash_session_token(plaintext_token)
        with self._database.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT sessions.id AS session_id, sessions.csrf_secret, sessions.expires_at, "
                "users.id AS user_id, users.household_id, users.display_name, users.role "
                "FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_sha256 = ? AND sessions.revoked_at IS NULL "
                "AND sessions.expires_at > ? AND users.status = 'active' "
                "AND sessions.auth_version = users.auth_version",
                (token_sha256, timestamp),
            ).fetchone()
        if row is None:
            raise AuthError(AuthErrorCode.INVALID_SESSION)
        return SessionRecord(
            id=UUID(row["session_id"]),
            household_id=UUID(row["household_id"]),
            user=AuthenticatedUser(
                id=UUID(row["user_id"]),
                display_name=row["display_name"],
                role=row["role"],
            ),
            csrf_secret=bytes(row["csrf_secret"]),
            expires_at=int(row["expires_at"]),
        )

    def authorize_mutation(
        self,
        connection: sqlite3.Connection,
        plaintext_token: str,
        csrf_token: str,
        *,
        now: int | None = None,
    ) -> SessionRecord:
        timestamp = now or _now_epoch()
        row = connection.execute(
            "SELECT sessions.id AS session_id, sessions.csrf_secret, sessions.expires_at, "
            "users.id AS user_id, users.household_id, users.display_name, users.role "
            "FROM sessions JOIN users ON users.id = sessions.user_id "
            "WHERE sessions.token_sha256 = ? AND sessions.revoked_at IS NULL "
            "AND sessions.expires_at > ? AND users.status = 'active' "
            "AND sessions.auth_version = users.auth_version",
            (hash_session_token(plaintext_token), timestamp),
        ).fetchone()
        if row is None:
            raise AuthError(AuthErrorCode.INVALID_SESSION)
        session_id = UUID(row["session_id"])
        csrf_secret = bytes(row["csrf_secret"])
        if not verify_csrf_token(csrf_token, session_id, csrf_secret):
            raise AuthError(AuthErrorCode.INVALID_CSRF)
        return SessionRecord(
            id=session_id,
            household_id=UUID(row["household_id"]),
            user=AuthenticatedUser(
                id=UUID(row["user_id"]),
                display_name=row["display_name"],
                role=row["role"],
            ),
            csrf_secret=csrf_secret,
            expires_at=int(row["expires_at"]),
        )

    def recover(
        self,
        recovery_code: str,
        new_password: str,
        *,
        now: int | None = None,
    ) -> AuthenticatedSession:
        timestamp = now or _now_epoch()
        if not self._database.is_setup_complete():
            raise AuthError(AuthErrorCode.SETUP_REQUIRED)
        self._require_not_locked("recovery", timestamp)
        with self._database.connect(read_only=True) as connection:
            candidates = connection.execute(
                "SELECT recovery_codes.id, recovery_codes.code_hmac, recovery_codes.batch_id, "
                "users.id AS user_id, users.household_id, users.display_name, users.role, "
                "users.auth_version "
                "FROM recovery_codes JOIN users ON users.id = recovery_codes.user_id "
                "WHERE recovery_codes.used_at IS NULL AND recovery_codes.revoked_at IS NULL "
                "AND users.role = 'owner' AND users.status = 'active'"
            ).fetchall()
        matched = next(
            (
                row
                for row in candidates
                if verify_recovery_code(recovery_code, row["code_hmac"], self._recovery_pepper)
            ),
            None,
        )
        if matched is None:
            retry_after = self._record_failure("recovery", timestamp)
            if retry_after:
                raise AuthError(AuthErrorCode.TRY_LATER, retry_after=retry_after)
            raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)

        password_hash = self._passwords.hash(new_password)
        issued = issue_session_token()
        session_id = uuid4()
        csrf_secret = os.urandom(32)
        expires_at = timestamp + self._session_ttl_seconds
        new_batch_id = uuid4()
        replacement_codes = generate_recovery_codes(self._recovery_pepper)
        user_id = UUID(matched["user_id"])
        invalidated = False
        new_auth_version = int(matched["auth_version"]) + 1

        with self._database.transaction() as connection:
            current = connection.execute(
                "SELECT used_at, revoked_at FROM recovery_codes WHERE id = ?",
                (matched["id"],),
            ).fetchone()
            current_user = connection.execute(
                "SELECT status, auth_version FROM users WHERE id = ?",
                (str(user_id),),
            ).fetchone()
            if (
                current is None
                or current["used_at"] is not None
                or current["revoked_at"] is not None
                or current_user is None
                or current_user["status"] != "active"
                or int(current_user["auth_version"]) != int(matched["auth_version"])
            ):
                invalidated = True
            else:
                connection.execute(
                    "UPDATE recovery_codes SET used_at = ? WHERE id = ?",
                    (timestamp, matched["id"]),
                )
                connection.execute(
                    "UPDATE recovery_codes SET revoked_at = ? "
                    "WHERE user_id = ? AND batch_id = ? AND revoked_at IS NULL",
                    (timestamp, str(user_id), matched["batch_id"]),
                )
                connection.execute(
                    "UPDATE sessions SET revoked_at = ? "
                    "WHERE user_id = ? AND revoked_at IS NULL",
                    (timestamp, str(user_id)),
                )
                connection.execute(
                    "UPDATE users SET password_hash = ?, auth_version = ?, updated_at = ?, "
                    "password_changed_at = ? WHERE id = ? AND status = 'active'",
                    (
                        password_hash,
                        new_auth_version,
                        timestamp,
                        timestamp,
                        str(user_id),
                    ),
                )
                for code_id, code_hmac in zip(
                    (uuid4() for _ in replacement_codes.hmac_sha256),
                    replacement_codes.hmac_sha256,
                    strict=True,
                ):
                    connection.execute(
                        "INSERT INTO recovery_codes "
                        "(id, user_id, batch_id, code_hmac, created_at, used_at, revoked_at) "
                        "VALUES (?, ?, ?, ?, ?, NULL, NULL)",
                        (
                            str(code_id),
                            str(user_id),
                            str(new_batch_id),
                            code_hmac,
                            timestamp,
                        ),
                    )
                _insert_session(
                    connection,
                    session_id=session_id,
                    user_id=user_id,
                    token_sha256=issued.sha256,
                    csrf_secret=csrf_secret,
                    auth_version=new_auth_version,
                    created_at=timestamp,
                    expires_at=expires_at,
                )
                connection.execute(
                    "INSERT INTO auth_throttles "
                    "(scope, consecutive_failures, locked_until, updated_at) "
                    "VALUES ('recovery', 0, NULL, ?) "
                    "ON CONFLICT(scope) DO UPDATE SET consecutive_failures = 0, "
                    "locked_until = NULL, updated_at = excluded.updated_at",
                    (timestamp,),
                )
                _append_audit(
                    connection,
                    household_id=matched["household_id"],
                    actor_user_id=str(user_id),
                    action="password_recovery",
                    entity_kind="user",
                    entity_id=str(user_id),
                    outcome="success",
                    occurred_at=timestamp,
                )
        if invalidated:
            retry_after = self._record_failure("recovery", timestamp)
            if retry_after:
                raise AuthError(AuthErrorCode.TRY_LATER, retry_after=retry_after)
            raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)
        return AuthenticatedSession(
            id=session_id,
            user=AuthenticatedUser(
                id=user_id,
                display_name=matched["display_name"],
                role=matched["role"],
            ),
            plaintext_token=issued.plaintext,
            csrf_token=issue_csrf_token(session_id, csrf_secret),
            expires_at=expires_at,
            recovery_codes=replacement_codes.plaintext_codes,
        )

    def issue_csrf(self, record: SessionRecord) -> str:
        return issue_csrf_token(record.id, record.csrf_secret)

    def reauthenticate(
        self,
        plaintext_token: str,
        password: str,
        *,
        now: int | None = None,
    ) -> SessionRecord:
        timestamp = now or _now_epoch()
        self._require_not_locked("login", timestamp)
        record = self.session(plaintext_token, now=timestamp)
        with self._database.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT password_hash FROM users WHERE id = ? AND status = 'active'",
                (str(record.user.id),),
            ).fetchone()
        if row is None or row["password_hash"] is None or not self._passwords.verify(
            row["password_hash"], password
        ):
            retry_after = self._record_failure("login", timestamp)
            if retry_after:
                raise AuthError(AuthErrorCode.TRY_LATER, retry_after=retry_after)
            raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)
        with self._database.transaction() as connection:
            connection.execute(
                "INSERT INTO auth_throttles "
                "(scope, consecutive_failures, locked_until, updated_at) "
                "VALUES ('login', 0, NULL, ?) ON CONFLICT(scope) DO UPDATE SET "
                "consecutive_failures = 0, locked_until = NULL, updated_at = excluded.updated_at",
                (timestamp,),
            )
        return record

    def logout(
        self,
        plaintext_token: str,
        csrf_token: str,
        *,
        now: int | None = None,
    ) -> None:
        timestamp = now or _now_epoch()
        token_sha256 = hash_session_token(plaintext_token)
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT sessions.id, sessions.csrf_secret, sessions.expires_at, "
                "sessions.revoked_at, users.id AS user_id, users.household_id, users.auth_version, "
                "sessions.auth_version AS session_auth_version, users.status "
                "FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_sha256 = ?",
                (token_sha256,),
            ).fetchone()
            if (
                row is None
                or row["revoked_at"] is not None
                or int(row["expires_at"]) <= timestamp
                or row["status"] != "active"
                or int(row["auth_version"]) != int(row["session_auth_version"])
            ):
                raise AuthError(AuthErrorCode.INVALID_SESSION)
            session_id = UUID(row["id"])
            if not verify_csrf_token(csrf_token, session_id, bytes(row["csrf_secret"])):
                raise AuthError(AuthErrorCode.INVALID_CSRF)
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                (timestamp, str(session_id)),
            )
            _append_audit(
                connection,
                household_id=row["household_id"],
                actor_user_id=row["user_id"],
                action="logout",
                entity_kind="session",
                entity_id=str(session_id),
                outcome="success",
                occurred_at=timestamp,
            )

    def _require_not_locked(self, scope: str, timestamp: int) -> None:
        with self._database.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT locked_until FROM auth_throttles WHERE scope = ?",
                (scope,),
            ).fetchone()
        if row is not None and row["locked_until"] is not None:
            remaining = int(row["locked_until"]) - timestamp
            if remaining > 0:
                raise AuthError(AuthErrorCode.TRY_LATER, retry_after=remaining)

    def _record_failure(self, scope: str, timestamp: int) -> int:
        with self._database.transaction() as connection:
            row = connection.execute(
                "SELECT consecutive_failures FROM auth_throttles WHERE scope = ?",
                (scope,),
            ).fetchone()
            failures = (int(row["consecutive_failures"]) if row else 0) + 1
            delay = self._backoff.delay_seconds(failures)
            locked_until = timestamp + delay if delay else None
            connection.execute(
                "INSERT INTO auth_throttles "
                "(scope, consecutive_failures, locked_until, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(scope) DO UPDATE SET "
                "consecutive_failures = excluded.consecutive_failures, "
                "locked_until = excluded.locked_until, updated_at = excluded.updated_at",
                (scope, failures, locked_until, timestamp),
            )
        return delay


def _insert_session(
    connection: sqlite3.Connection,
    *,
    session_id: UUID,
    user_id: UUID,
    token_sha256: str,
    csrf_secret: bytes,
    auth_version: int,
    created_at: int,
    expires_at: int,
) -> None:
    connection.execute(
        "INSERT INTO sessions "
        "(id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, "
        "last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        (
            str(session_id),
            str(user_id),
            token_sha256,
            csrf_secret,
            auth_version,
            created_at,
            expires_at,
            created_at,
        ),
    )


def _append_audit(
    connection: sqlite3.Connection,
    *,
    household_id: str,
    actor_user_id: str | None,
    action: str,
    entity_kind: str,
    entity_id: str | None,
    outcome: str,
    occurred_at: int,
) -> None:
    previous = connection.execute(
        "SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1"
    ).fetchone()
    previous_hash = previous[0] if previous else None
    event_id = str(uuid4())
    event_hash = event_hash_v1(
        event_id=event_id,
        household_id=household_id,
        actor_user_id=actor_user_id,
        action=action,
        entity_kind=entity_kind,
        entity_id=entity_id,
        outcome=outcome,
        occurred_at=occurred_at,
        previous_hash=previous_hash,
    )
    connection.execute(
        "INSERT INTO audit_events "
        "(id, household_id, actor_user_id, action, entity_kind, entity_id, outcome, "
        "metadata_json, occurred_at, previous_hash, event_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)",
        (
            event_id,
            household_id,
            actor_user_id,
            action,
            entity_kind,
            entity_id,
            outcome,
            occurred_at,
            previous_hash,
            event_hash,
        ),
    )


def append_audit_event(
    connection: sqlite3.Connection,
    *,
    household_id: str,
    actor_user_id: str | None,
    action: str,
    entity_kind: str,
    entity_id: str | None,
    outcome: str,
    occurred_at: int,
) -> None:
    _append_audit(
        connection,
        household_id=household_id,
        actor_user_id=actor_user_id,
        action=action,
        entity_kind=entity_kind,
        entity_id=entity_id,
        outcome=outcome,
        occurred_at=occurred_at,
    )


def _required_text(value: str, *, maximum: int) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or "\x00" in normalized:
        raise ValueError("invalid display text")
    return normalized


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())
