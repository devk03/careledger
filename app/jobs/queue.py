import json
import sqlite3
from dataclasses import dataclass
from enum import StrEnum

from app.storage.database import Database

_JOB_TYPES = {"preprocess", "extract", "reindex", "backup", "restore_verify"}


class JobQueueErrorCode(StrEnum):
    INVALID_JOB_TYPE = "INVALID_JOB_TYPE"
    LEASE_LOST = "LEASE_LOST"


class JobQueueError(RuntimeError):
    def __init__(self, code: JobQueueErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class JobLease:
    id: str
    household_id: str
    care_profile_id: str | None
    document_id: str | None
    job_type: str
    payload: dict[str, object]
    attempts: int
    max_attempts: int
    lease_owner: str
    lease_expires_at: int


class JobQueue:
    def __init__(self, database: Database) -> None:
        self._database = database

    def lease_next(
        self,
        job_type: str,
        *,
        worker_id: str,
        now: int,
        lease_seconds: int = 60,
    ) -> JobLease | None:
        if job_type not in _JOB_TYPES:
            raise JobQueueError(JobQueueErrorCode.INVALID_JOB_TYPE)
        if not worker_id or lease_seconds < 1:
            raise ValueError("worker ID and positive lease duration are required")
        with self._database.transaction() as connection:
            _reclaim_expired(connection, now)
            row = connection.execute(
                "SELECT id FROM jobs WHERE job_type = ? AND state IN ('queued', 'retry') "
                "AND available_at <= ? ORDER BY priority DESC, available_at, created_at, id "
                "LIMIT 1",
                (job_type, now),
            ).fetchone()
            if row is None:
                return None
            expires_at = now + lease_seconds
            changed = connection.execute(
                "UPDATE jobs SET state = 'leased', attempts = attempts + 1, lease_owner = ?, "
                "lease_expires_at = ?, safe_error_code = NULL, updated_at = ? "
                "WHERE id = ? AND state IN ('queued', 'retry')",
                (worker_id, expires_at, now, row["id"]),
            ).rowcount
            if changed != 1:
                return None
            leased = connection.execute(
                "SELECT id, household_id, care_profile_id, document_id, job_type, payload_json, "
                "attempts, max_attempts, lease_owner, lease_expires_at FROM jobs WHERE id = ?",
                (row["id"],),
            ).fetchone()
        if leased is None:
            raise JobQueueError(JobQueueErrorCode.LEASE_LOST)
        payload = json.loads(leased["payload_json"])
        if not isinstance(payload, dict):
            raise ValueError("job payload must be a JSON object")
        return JobLease(
            id=leased["id"],
            household_id=leased["household_id"],
            care_profile_id=leased["care_profile_id"],
            document_id=leased["document_id"],
            job_type=leased["job_type"],
            payload=payload,
            attempts=int(leased["attempts"]),
            max_attempts=int(leased["max_attempts"]),
            lease_owner=leased["lease_owner"],
            lease_expires_at=int(leased["lease_expires_at"]),
        )

    def fail(
        self,
        lease: JobLease,
        *,
        safe_error_code: str,
        now: int,
        retry_delay_seconds: int = 5,
    ) -> str:
        if not safe_error_code or retry_delay_seconds < 0:
            raise ValueError("safe error code and non-negative retry delay are required")
        terminal = lease.attempts >= lease.max_attempts
        state = "failed" if terminal else "retry"
        completed_at = now if terminal else None
        available_at = now if terminal else now + retry_delay_seconds
        with self._database.transaction() as connection:
            changed = connection.execute(
                "UPDATE jobs SET state = ?, available_at = ?, lease_owner = NULL, "
                "lease_expires_at = NULL, safe_error_code = ?, updated_at = ?, completed_at = ? "
                "WHERE id = ? AND state = 'leased' AND lease_owner = ?",
                (
                    state,
                    available_at,
                    safe_error_code,
                    now,
                    completed_at,
                    lease.id,
                    lease.lease_owner,
                ),
            ).rowcount
        if changed != 1:
            raise JobQueueError(JobQueueErrorCode.LEASE_LOST)
        return state

    def complete(self, lease: JobLease, *, now: int) -> None:
        with self._database.transaction() as connection:
            changed = connection.execute(
                "UPDATE jobs SET state = 'completed', lease_owner = NULL, "
                "lease_expires_at = NULL, safe_error_code = NULL, updated_at = ?, "
                "completed_at = ? WHERE id = ? AND state = 'leased' AND lease_owner = ?",
                (now, now, lease.id, lease.lease_owner),
            ).rowcount
        if changed != 1:
            raise JobQueueError(JobQueueErrorCode.LEASE_LOST)


def require_active_lease(
    connection: sqlite3.Connection,
    lease: JobLease,
    *,
    now: int,
) -> None:
    row = connection.execute(
        "SELECT 1 FROM jobs WHERE id = ? AND state = 'leased' AND lease_owner = ? "
        "AND lease_expires_at >= ?",
        (lease.id, lease.lease_owner, now),
    ).fetchone()
    if row is None:
        raise JobQueueError(JobQueueErrorCode.LEASE_LOST)


def _reclaim_expired(connection: sqlite3.Connection, now: int) -> None:
    connection.execute(
        "UPDATE jobs SET state = CASE WHEN attempts >= max_attempts "
        "THEN 'failed' ELSE 'retry' END, "
        "available_at = ?, lease_owner = NULL, lease_expires_at = NULL, "
        "safe_error_code = 'LEASE_EXPIRED', updated_at = ?, "
        "completed_at = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END "
        "WHERE state = 'leased' AND lease_expires_at < ?",
        (now, now, now, now),
    )
