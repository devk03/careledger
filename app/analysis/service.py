import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from app.ai.prompts import prompt_sha256
from app.ai.provider import AIProviderRuntime
from app.ai.schema import schema_sha256
from app.security.auth import AuthService, append_audit_event
from app.storage.database import Database


class AnalysisErrorCode(StrEnum):
    AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED"
    EXTERNAL_TRANSFER_NOT_CONFIRMED = "EXTERNAL_TRANSFER_NOT_CONFIRMED"
    DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND"
    DOCUMENT_NOT_READY = "DOCUMENT_NOT_READY"


class AnalysisError(RuntimeError):
    def __init__(self, code: AnalysisErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class AIStatus:
    enabled: bool
    provider: str
    model: str | None
    external_transfer_required: bool


@dataclass(frozen=True)
class AnalysisRequestRecord:
    job_id: UUID
    state: str
    provider: str
    model: str
    already_requested: bool


class AnalysisService:
    def __init__(
        self,
        database: Database,
        auth: AuthService,
        provider: AIProviderRuntime,
    ) -> None:
        self._database = database
        self._auth = auth
        self._provider = provider

    def status(self, plaintext_token: str) -> AIStatus:
        self._auth.session(plaintext_token)
        return AIStatus(
            enabled=self._provider.enabled,
            provider=self._provider.provider.value,
            model=self._provider.model,
            external_transfer_required=self._provider.external_transfer_required,
        )

    def request_analysis(
        self,
        plaintext_token: str,
        csrf_token: str,
        document_id: UUID,
        *,
        acknowledge_external_transfer: bool,
        now: int | None = None,
    ) -> AnalysisRequestRecord:
        timestamp = now or _now_epoch()
        if not self._provider.enabled or not self._provider.model:
            raise AnalysisError(AnalysisErrorCode.AI_NOT_CONFIGURED)
        if self._provider.external_transfer_required and not acknowledge_external_transfer:
            raise AnalysisError(AnalysisErrorCode.EXTERNAL_TRANSFER_NOT_CONFIRMED)
        batch_token = str(uuid4())
        job_id = uuid4()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
            document = connection.execute(
                "SELECT documents.id, documents.care_profile_id, documents.source_sha256, "
                "documents.status FROM documents "
                "JOIN care_profiles ON care_profiles.id = documents.care_profile_id "
                "WHERE documents.id = ? AND care_profiles.household_id = ? "
                "AND documents.archived_at IS NULL",
                (str(document_id), str(session.household_id)),
            ).fetchone()
            if document is None:
                raise AnalysisError(AnalysisErrorCode.DOCUMENT_NOT_FOUND)
            if document["status"] not in {"ready", "needs_review", "complete"}:
                raise AnalysisError(AnalysisErrorCode.DOCUMENT_NOT_READY)
            idempotency_key = ":".join(
                (
                    "extract-v1",
                    str(document_id),
                    document["source_sha256"],
                    self._provider.provider.value,
                    self._provider.model,
                    prompt_sha256(),
                    schema_sha256(),
                )
            )
            payload_json = json.dumps(
                {
                    "batch_token": batch_token,
                    "created_by": str(session.user.id),
                    "document_id": str(document_id),
                    "model": self._provider.model,
                    "provider": self._provider.provider.value,
                    "source_sha256": document["source_sha256"],
                },
                separators=(",", ":"),
                sort_keys=True,
            )
            payload_sha256 = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
            inserted = connection.execute(
                "INSERT INTO jobs "
                "(id, household_id, care_profile_id, document_id, job_type, state, payload_json, "
                "payload_sha256, idempotency_key, priority, attempts, max_attempts, available_at, "
                "lease_owner, lease_expires_at, safe_error_code, created_by, created_at, "
                "updated_at, completed_at) VALUES (?, ?, ?, ?, 'extract', 'queued', ?, ?, ?, "
                "0, 0, 3, ?, NULL, NULL, NULL, ?, ?, ?, NULL) "
                "ON CONFLICT(household_id, idempotency_key) DO NOTHING",
                (
                    str(job_id),
                    str(session.household_id),
                    document["care_profile_id"],
                    str(document_id),
                    payload_json,
                    payload_sha256,
                    idempotency_key,
                    timestamp,
                    str(session.user.id),
                    timestamp,
                    timestamp,
                ),
            ).rowcount
            if inserted:
                append_audit_event(
                    connection,
                    household_id=str(session.household_id),
                    actor_user_id=str(session.user.id),
                    action="analysis_requested",
                    entity_kind="document",
                    entity_id=str(document_id),
                    outcome="success",
                    occurred_at=timestamp,
                )
            job = connection.execute(
                "SELECT id, state FROM jobs WHERE household_id = ? AND idempotency_key = ?",
                (str(session.household_id), idempotency_key),
            ).fetchone()
        if job is None:
            raise RuntimeError("analysis job was not persisted")
        return AnalysisRequestRecord(
            job_id=UUID(job["id"]),
            state=job["state"],
            provider=self._provider.provider.value,
            model=self._provider.model,
            already_requested=not bool(inserted),
        )


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())
