import asyncio
from contextlib import suppress
from datetime import UTC, datetime
from uuid import UUID

from app.ai.inputs import PageContext, SourceBatch
from app.ai.provider import AIProviderRuntime
from app.ai.request import opaque_safety_identifier
from app.ai.validators import ExtractionRejected
from app.evidence.persistence import EvidencePersistence
from app.ingest.models import MediaType
from app.jobs.queue import JobLease, JobQueue, JobQueueError
from app.storage.database import Database
from app.storage.objects import ContentAddressedObjectStore


class ExtractionWorker:
    def __init__(
        self,
        database: Database,
        object_store: ContentAddressedObjectStore,
        provider: AIProviderRuntime,
        *,
        safety_secret: bytes,
        worker_id: str,
    ) -> None:
        self._database = database
        self._objects = object_store
        self._provider = provider
        self._safety_secret = safety_secret
        self._queue = JobQueue(database)
        self._evidence = EvidencePersistence(database)
        self._worker_id = worker_id

    def process_once(self, *, now: int | None = None) -> bool:
        if not self._provider.enabled:
            return False
        timestamp = now or _now_epoch()
        lease = self._queue.lease_next("extract", worker_id=self._worker_id, now=timestamp)
        if lease is None:
            return False
        try:
            if self._validated_run_exists(lease.id):
                self._queue.complete(lease, now=timestamp)
                return True
            batch, created_by = self._source_batch(lease)
            extraction = self._provider.extraction_service().extract(
                batch,
                safety_identifier=opaque_safety_identifier(created_by, self._safety_secret),
            )
            self._evidence.store_validated(
                document_id=UUID(_payload_text(lease, "document_id")),
                created_by=UUID(created_by),
                provider=self._provider.provider.value,
                extraction=extraction,
                pages=batch.pages,
                job_id=lease.id,
                now=timestamp,
            )
            self._queue.complete(lease, now=timestamp)
        except JobQueueError:
            raise
        except ExtractionRejected as error:
            self._queue.fail(
                lease,
                safe_error_code=error.code.value,
                now=timestamp,
                retry_delay_seconds=0,
            )
        except (OSError, ValueError):
            self._queue.fail(
                lease,
                safe_error_code="INVALID_AI_INPUT",
                now=timestamp,
                retry_delay_seconds=0,
            )
        except Exception:  # noqa: BLE001 - never persist provider error bodies or record text
            self._queue.fail(
                lease,
                safe_error_code="AI_PROVIDER_ERROR",
                now=timestamp,
            )
        return True

    def _validated_run_exists(self, job_id: str) -> bool:
        with self._database.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT 1 FROM extraction_runs WHERE job_id = ? AND status = 'validated'",
                (job_id,),
            ).fetchone()
        return row is not None

    def _source_batch(self, lease: JobLease) -> tuple[SourceBatch, str]:
        document_id = _payload_text(lease, "document_id")
        source_sha256 = _payload_text(lease, "source_sha256")
        created_by = _payload_text(lease, "created_by")
        if document_id != lease.document_id:
            raise ValueError("job document scope is invalid")
        with self._database.connect(read_only=True) as connection:
            document = connection.execute(
                "SELECT documents.source_sha256, source_objects.media_type FROM documents "
                "JOIN source_objects ON source_objects.sha256 = documents.source_sha256 "
                "WHERE documents.id = ? AND documents.care_profile_id = ?",
                (document_id, lease.care_profile_id),
            ).fetchone()
            pages = connection.execute(
                "SELECT document_pages.page_number, document_pages.extracted_text, "
                "derived_artifacts.sha256 FROM document_pages "
                "JOIN derived_artifacts "
                "ON derived_artifacts.document_id = document_pages.document_id "
                "AND derived_artifacts.page_number = document_pages.page_number "
                "AND derived_artifacts.kind = 'normalized_input' "
                "WHERE document_pages.document_id = ? ORDER BY document_pages.page_number",
                (document_id,),
            ).fetchall()
        if document is None or document["source_sha256"] != source_sha256 or not pages:
            raise ValueError("document is not ready for extraction")
        if not self._objects.verify(source_sha256):
            raise ValueError("source object failed integrity verification")
        with self._objects.open(source_sha256) as handle:
            source_bytes = handle.read()
        return (
            SourceBatch(
                batch_token=_payload_text(lease, "batch_token"),
                source_bytes=source_bytes,
                transmitted_bytes=source_bytes,
                media_type=MediaType(document["media_type"]),
                pages=tuple(
                    PageContext(
                        page_number=int(page["page_number"]),
                        text=page["extracted_text"],
                        artifact_sha256=page["sha256"],
                    )
                    for page in pages
                ),
            ),
            created_by,
        )


class BackgroundExtractionWorker:
    def __init__(self, worker: ExtractionWorker, *, idle_seconds: float = 1.0) -> None:
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
