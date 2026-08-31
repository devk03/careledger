import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

from app.ingest.models import UploadRejected
from app.ingest.pipeline import UploadIntake
from app.security.auth import AuthService, append_audit_event
from app.storage.database import Database


class RecordErrorCode(StrEnum):
    INVALID_PROFILE = "INVALID_PROFILE"
    OBJECT_METADATA_MISMATCH = "OBJECT_METADATA_MISMATCH"


class RecordError(RuntimeError):
    def __init__(self, code: RecordErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class CareProfileRecord:
    id: UUID
    preferred_name: str
    created_at: int


@dataclass(frozen=True)
class DocumentRecord:
    id: UUID
    care_profile_id: UUID
    display_name: str
    media_type: str
    source_sha256: str
    byte_size: int
    page_count: int
    status: str
    scan_verdict: str
    uploaded_at: int
    job_id: UUID
    duplicate_source: bool


class RecordService:
    def __init__(
        self,
        database: Database,
        auth: AuthService,
        intake: UploadIntake,
    ) -> None:
        self._database = database
        self._auth = auth
        self._intake = intake

    def list_profiles(self, plaintext_token: str) -> tuple[CareProfileRecord, ...]:
        session = self._auth.session(plaintext_token)
        with self._database.connect(read_only=True) as connection:
            rows = connection.execute(
                "SELECT id, preferred_name, created_at FROM care_profiles "
                "WHERE household_id = ? AND archived_at IS NULL ORDER BY created_at, id",
                (str(session.household_id),),
            ).fetchall()
        return tuple(
            CareProfileRecord(
                id=UUID(row["id"]),
                preferred_name=row["preferred_name"],
                created_at=int(row["created_at"]),
            )
            for row in rows
        )

    def create_profile(
        self,
        plaintext_token: str,
        csrf_token: str,
        preferred_name: str,
        *,
        now: int | None = None,
    ) -> CareProfileRecord:
        timestamp = now or _now_epoch()
        name = _preferred_name(preferred_name)
        profile_id = uuid4()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
            connection.execute(
                "INSERT INTO care_profiles "
                "(id, household_id, preferred_name, birth_date, created_by, created_at, "
                "updated_at, archived_at) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)",
                (
                    str(profile_id),
                    str(session.household_id),
                    name,
                    str(session.user.id),
                    timestamp,
                    timestamp,
                ),
            )
            append_audit_event(
                connection,
                household_id=str(session.household_id),
                actor_user_id=str(session.user.id),
                action="care_profile_created",
                entity_kind="care_profile",
                entity_id=str(profile_id),
                outcome="success",
                occurred_at=timestamp,
            )
        return CareProfileRecord(id=profile_id, preferred_name=name, created_at=timestamp)

    def upload_document(
        self,
        plaintext_token: str,
        csrf_token: str,
        care_profile_id: UUID,
        stream: BinaryIO,
        *,
        original_name: str,
        claimed_media_type: str | None,
        content_length: int | None = None,
        now: int | None = None,
    ) -> DocumentRecord:
        timestamp = now or _now_epoch()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
            _require_profile(connection, care_profile_id, session.household_id)

        staged = self._intake.receive(
            stream,
            original_name=original_name,
            claimed_media_type=claimed_media_type,
            content_length=content_length,
        )
        validated = self._intake.validate(staged)
        accepted = self._intake.promote(validated)
        scan_engine = validated.scan_report.engine if validated.scan_report is not None else None
        page_count = accepted.page_count or 1
        document_id = uuid4()
        job_id = uuid4()
        payload_json = json.dumps(
            {
                "document_id": str(document_id),
                "source_sha256": accepted.digest,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        payload_sha256 = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
            _require_profile(connection, care_profile_id, session.household_id)
            connection.execute(
                "INSERT INTO source_objects "
                "(sha256, byte_size, media_type, created_at, verified_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING",
                (
                    accepted.digest,
                    accepted.size,
                    accepted.media_type.value,
                    timestamp,
                    timestamp,
                ),
            )
            source = connection.execute(
                "SELECT byte_size, media_type FROM source_objects WHERE sha256 = ?",
                (accepted.digest,),
            ).fetchone()
            if (
                source is None
                or int(source["byte_size"]) != accepted.size
                or source["media_type"] != accepted.media_type.value
            ):
                raise RecordError(RecordErrorCode.OBJECT_METADATA_MISMATCH)
            connection.execute(
                "INSERT INTO documents "
                "(id, care_profile_id, source_sha256, original_display_name, title, "
                "record_date, record_date_text, scan_verdict, scan_engine, page_count, width, "
                "height, status, safe_error_code, uploaded_by, uploaded_at, archived_at) "
                "VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'processing', NULL, "
                "?, ?, NULL)",
                (
                    str(document_id),
                    str(care_profile_id),
                    accepted.digest,
                    accepted.display_name,
                    accepted.scan_verdict.value,
                    scan_engine,
                    page_count,
                    accepted.width,
                    accepted.height,
                    str(session.user.id),
                    timestamp,
                ),
            )
            for page_number in range(1, page_count + 1):
                connection.execute(
                    "INSERT INTO document_pages "
                    "(document_id, page_number, extracted_text, text_sha256, extraction_method, "
                    "created_by_job_id, created_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?)",
                    (str(document_id), page_number, str(job_id), timestamp),
                )
            connection.execute(
                "INSERT INTO jobs "
                "(id, household_id, care_profile_id, document_id, job_type, state, payload_json, "
                "payload_sha256, idempotency_key, priority, attempts, max_attempts, available_at, "
                "lease_owner, lease_expires_at, safe_error_code, created_by, created_at, "
                "updated_at, completed_at) "
                "VALUES (?, ?, ?, ?, 'preprocess', 'queued', ?, ?, ?, 0, 0, 3, ?, NULL, NULL, "
                "NULL, ?, ?, ?, NULL)",
                (
                    str(job_id),
                    str(session.household_id),
                    str(care_profile_id),
                    str(document_id),
                    payload_json,
                    payload_sha256,
                    f"preprocess:{document_id}:{accepted.digest}",
                    timestamp,
                    str(session.user.id),
                    timestamp,
                    timestamp,
                ),
            )
            append_audit_event(
                connection,
                household_id=str(session.household_id),
                actor_user_id=str(session.user.id),
                action="document_uploaded",
                entity_kind="document",
                entity_id=str(document_id),
                outcome="success",
                occurred_at=timestamp,
            )
        return DocumentRecord(
            id=document_id,
            care_profile_id=care_profile_id,
            display_name=accepted.display_name,
            media_type=accepted.media_type.value,
            source_sha256=accepted.digest,
            byte_size=accepted.size,
            page_count=page_count,
            status="processing",
            scan_verdict=accepted.scan_verdict.value,
            uploaded_at=timestamp,
            job_id=job_id,
            duplicate_source=accepted.already_existed,
        )

    def list_documents(
        self,
        plaintext_token: str,
        care_profile_id: UUID,
    ) -> tuple[DocumentRecord, ...]:
        session = self._auth.session(plaintext_token)
        with self._database.connect(read_only=True) as connection:
            _require_profile(connection, care_profile_id, session.household_id)
            rows = connection.execute(
                "SELECT documents.id, documents.care_profile_id, documents.original_display_name, "
                "source_objects.media_type, documents.source_sha256, source_objects.byte_size, "
                "documents.page_count, documents.status, documents.scan_verdict, "
                "documents.uploaded_at, jobs.id AS job_id "
                "FROM documents JOIN source_objects "
                "ON source_objects.sha256 = documents.source_sha256 "
                "JOIN jobs ON jobs.document_id = documents.id AND jobs.job_type = 'preprocess' "
                "WHERE documents.care_profile_id = ? ORDER BY documents.uploaded_at DESC",
                (str(care_profile_id),),
            ).fetchall()
        return tuple(
            DocumentRecord(
                id=UUID(row["id"]),
                care_profile_id=UUID(row["care_profile_id"]),
                display_name=row["original_display_name"],
                media_type=row["media_type"],
                source_sha256=row["source_sha256"],
                byte_size=int(row["byte_size"]),
                page_count=int(row["page_count"]),
                status=row["status"],
                scan_verdict=row["scan_verdict"],
                uploaded_at=int(row["uploaded_at"]),
                job_id=UUID(row["job_id"]),
                duplicate_source=False,
            )
            for row in rows
        )


def _require_profile(
    connection: sqlite3.Connection,
    care_profile_id: UUID,
    household_id: UUID,
) -> None:
    row = connection.execute(
        "SELECT 1 FROM care_profiles WHERE id = ? AND household_id = ? AND archived_at IS NULL",
        (str(care_profile_id), str(household_id)),
    ).fetchone()
    if row is None:
        raise RecordError(RecordErrorCode.INVALID_PROFILE)


def _preferred_name(value: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > 120 or "\x00" in normalized:
        raise ValueError("invalid preferred name")
    return normalized


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())


def build_record_service(
    database: Database,
    auth: AuthService,
    *,
    quarantine_root: Path,
    object_root: Path,
    max_upload_bytes: int,
    max_pdf_pages: int,
    max_image_pixels: int,
    max_image_dimension: int,
) -> RecordService:
    from app.storage.objects import ContentAddressedObjectStore

    intake = UploadIntake(
        quarantine_root=quarantine_root,
        object_store=ContentAddressedObjectStore(object_root),
        max_upload_bytes=max_upload_bytes,
        max_pdf_pages=max_pdf_pages,
        max_image_pixels=max_image_pixels,
        max_image_dimension=max_image_dimension,
    )
    return RecordService(database, auth, intake)


__all__ = [
    "CareProfileRecord",
    "DocumentRecord",
    "RecordError",
    "RecordErrorCode",
    "RecordService",
    "UploadRejected",
    "build_record_service",
]
