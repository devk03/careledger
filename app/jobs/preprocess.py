import asyncio
from contextlib import suppress
from datetime import UTC, datetime
from uuid import uuid4

from app.jobs.queue import (
    JobLease,
    JobQueue,
    JobQueueError,
    JobQueueErrorCode,
    require_active_lease,
)
from app.security.auth import append_audit_event
from app.storage.database import Database
from app.storage.objects import ContentAddressedObjectStore


class PreprocessWorker:
    def __init__(
        self,
        database: Database,
        object_store: ContentAddressedObjectStore,
        *,
        worker_id: str,
    ) -> None:
        self._database = database
        self._objects = object_store
        self._queue = JobQueue(database)
        self._worker_id = worker_id

    def process_once(self, *, now: int | None = None) -> bool:
        timestamp = now or _now_epoch()
        lease = self._queue.lease_next(
            "preprocess",
            worker_id=self._worker_id,
            now=timestamp,
        )
        if lease is None:
            return False
        try:
            self._process(lease, now=timestamp)
        except JobQueueError:
            raise
        except (OSError, ValueError):
            self._queue.fail(
                lease,
                safe_error_code="SOURCE_OBJECT_INTEGRITY",
                now=timestamp,
            )
        except Exception:  # noqa: BLE001 - persisted errors must remain non-sensitive
            self._queue.fail(
                lease,
                safe_error_code="PREPROCESS_FAILED",
                now=timestamp,
            )
        return True

    def _process(self, lease: JobLease, *, now: int) -> None:
        document_id = _payload_text(lease, "document_id")
        source_sha256 = _payload_text(lease, "source_sha256")
        if document_id != lease.document_id or not self._objects.verify(source_sha256):
            raise ValueError("source object or job scope is invalid")
        source_path = self._objects.path_for(source_sha256)
        storage_key = (
            f"objects/sha256/{source_sha256[:2]}/{source_sha256[2:4]}/{source_sha256}"
        )
        with self._database.transaction() as connection:
            require_active_lease(connection, lease, now=now)
            document = connection.execute(
                "SELECT documents.page_count, documents.uploaded_by, documents.source_sha256, "
                "source_objects.byte_size, source_objects.media_type "
                "FROM documents JOIN source_objects "
                "ON source_objects.sha256 = documents.source_sha256 "
                "WHERE documents.id = ? AND documents.care_profile_id = ?",
                (document_id, lease.care_profile_id),
            ).fetchone()
            if (
                document is None
                or document["source_sha256"] != source_sha256
                or int(document["byte_size"]) != source_path.stat().st_size
            ):
                raise ValueError("document source metadata is invalid")
            for page_number in range(1, int(document["page_count"]) + 1):
                connection.execute(
                    "INSERT INTO derived_artifacts "
                    "(id, document_id, page_number, kind, sha256, byte_size, media_type, "
                    "storage_key, generator_version, created_by_job_id, created_at) "
                    "VALUES (?, ?, ?, 'normalized_input', ?, ?, ?, ?, "
                    "'careledger.pass-through.v1', "
                    "?, ?) ON CONFLICT(document_id, page_number, kind, sha256) DO NOTHING",
                    (
                        str(uuid4()),
                        document_id,
                        page_number,
                        source_sha256,
                        int(document["byte_size"]),
                        document["media_type"],
                        storage_key,
                        lease.id,
                        now,
                    ),
                )
            connection.execute(
                "UPDATE documents SET status = 'ready', safe_error_code = NULL WHERE id = ?",
                (document_id,),
            )
            changed = connection.execute(
                "UPDATE jobs SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL, "
                "safe_error_code = NULL, updated_at = ?, completed_at = ? "
                "WHERE id = ? AND state = 'leased' AND lease_owner = ?",
                (now, now, lease.id, lease.lease_owner),
            ).rowcount
            if changed != 1:
                raise JobQueueError(JobQueueErrorCode.LEASE_LOST)
            append_audit_event(
                connection,
                household_id=lease.household_id,
                actor_user_id=document["uploaded_by"],
                action="document_preprocessed",
                entity_kind="document",
                entity_id=document_id,
                outcome="success",
                occurred_at=now,
            )


class BackgroundPreprocessWorker:
    def __init__(self, worker: PreprocessWorker, *, idle_seconds: float = 1.0) -> None:
        self._worker = worker
        self._idle_seconds = idle_seconds
        self._stop = asyncio.Event()

    async def run(self) -> None:
        while not self._stop.is_set():
            worked = await asyncio.to_thread(self._worker.process_once)
            if not worked:
                with suppress(TimeoutError):
                    await asyncio.wait_for(self._stop.wait(), timeout=self._idle_seconds)

    def stop(self) -> None:
        self._stop.set()


def _payload_text(lease: JobLease, key: str) -> str:
    value = lease.payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError("job payload is invalid")
    return value


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())
