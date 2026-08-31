import hashlib
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from app.ai.contracts import ModelClaim, SourceQualifier, UncertaintyLevel
from app.ai.inputs import PageContext
from app.ai.schema import canonical_json
from app.ai.service import ValidatedExtraction
from app.security.auth import append_audit_event
from app.storage.database import Database


@dataclass(frozen=True)
class ProposedClaim:
    revision_id: UUID
    claim_id: UUID
    statement: str
    plain_language: str | None
    kind: str
    certainty: str
    qualifier_text: str | None
    citation_count: int


class EvidencePersistence:
    def __init__(self, database: Database) -> None:
        self._database = database

    def store_validated(
        self,
        *,
        document_id: UUID,
        created_by: UUID,
        provider: str,
        extraction: ValidatedExtraction,
        pages: tuple[PageContext, ...],
        job_id: str | None = None,
        now: int | None = None,
    ) -> tuple[ProposedClaim, ...]:
        timestamp = now or _now_epoch()
        run_id = uuid4()
        payload_json = canonical_json(extraction.payload.model_dump(mode="json"))
        payload_sha256 = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        page_artifacts = tuple(page.artifact_sha256 for page in pages)
        if page_artifacts != extraction.provenance.page_artifact_sha256:
            raise ValueError("page artifacts do not match validated extraction provenance")
        if not provider.strip():
            raise ValueError("provider is required")

        proposals: list[ProposedClaim] = []
        with self._database.transaction() as connection:
            scope = connection.execute(
                "SELECT documents.care_profile_id, documents.source_sha256, "
                "care_profiles.household_id FROM documents "
                "JOIN care_profiles ON care_profiles.id = documents.care_profile_id "
                "JOIN users ON users.id = ? AND users.household_id = care_profiles.household_id "
                "WHERE documents.id = ?",
                (str(created_by), str(document_id)),
            ).fetchone()
            if scope is None or scope["source_sha256"] != extraction.provenance.source_sha256:
                raise ValueError("document, actor, or source provenance is inconsistent")
            connection.execute(
                "INSERT INTO extraction_runs "
                "(id, document_id, job_id, status, provider, requested_model, response_model, "
                "contract_version, prompt_version, prompt_sha256, schema_sha256, request_sha256, "
                "source_sha256, transmitted_sha256, payload_sha256, sdk_version, batch_token, "
                "response_id, response_created_at, input_tokens, output_tokens, payload_json, "
                "safe_error_code, created_by, started_at, completed_at, created_at) "
                "VALUES (?, ?, ?, 'validated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                "?, ?, ?, NULL, ?, ?, ?, ?)",
                (
                    str(run_id),
                    str(document_id),
                    job_id,
                    provider,
                    extraction.provenance.requested_model,
                    extraction.provenance.response_model,
                    extraction.provenance.contract_version,
                    extraction.provenance.prompt_version,
                    extraction.provenance.prompt_sha256,
                    extraction.provenance.schema_sha256,
                    extraction.provenance.request_sha256,
                    extraction.provenance.source_sha256,
                    extraction.provenance.transmitted_sha256,
                    payload_sha256,
                    extraction.provenance.openai_sdk_version,
                    extraction.provenance.batch_token,
                    extraction.provenance.response_id,
                    extraction.provenance.response_created_at,
                    extraction.provenance.usage.get("input_tokens"),
                    extraction.provenance.usage.get("output_tokens"),
                    payload_json,
                    str(created_by),
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            )
            for page in pages:
                connection.execute(
                    "INSERT INTO extraction_run_pages "
                    "(extraction_run_id, page_number, artifact_sha256) VALUES (?, ?, ?)",
                    (str(run_id), page.page_number, page.artifact_sha256),
                )
            for model_claim in extraction.payload.claims:
                proposals.append(
                    _insert_proposed_claim(
                        connection,
                        model_claim=model_claim,
                        care_profile_id=scope["care_profile_id"],
                        document_id=str(document_id),
                        source_sha256=scope["source_sha256"],
                        run_id=str(run_id),
                        created_by=str(created_by),
                        now=timestamp,
                    )
                )
            connection.execute(
                "UPDATE documents SET status = 'needs_review', safe_error_code = NULL "
                "WHERE id = ?",
                (str(document_id),),
            )
            append_audit_event(
                connection,
                household_id=scope["household_id"],
                actor_user_id=str(created_by),
                action="extraction_proposed",
                entity_kind="document",
                entity_id=str(document_id),
                outcome="success",
                occurred_at=timestamp,
            )
        return tuple(proposals)


def _insert_proposed_claim(
    connection: sqlite3.Connection,
    *,
    model_claim: ModelClaim,
    care_profile_id: str,
    document_id: str,
    source_sha256: str,
    run_id: str,
    created_by: str,
    now: int,
) -> ProposedClaim:
    claim_id = uuid4()
    revision_id = uuid4()
    connection.execute(
        "INSERT INTO evidence_claims (id, care_profile_id, created_at) VALUES (?, ?, ?)",
        (str(claim_id), care_profile_id, now),
    )
    for position, citation in enumerate(model_claim.citations):
        box = citation.bbox
        connection.execute(
            "INSERT INTO citations "
            "(id, claim_revision_id, document_id, source_sha256, page_number, quote, "
            "bbox_x0, bbox_y0, bbox_x1, bbox_y1, position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid4()),
                str(revision_id),
                document_id,
                source_sha256,
                citation.page_number,
                citation.quote,
                box.x0 if box else None,
                box.y0 if box else None,
                box.x1 if box else None,
                box.y1 if box else None,
                position,
            ),
        )
    certainty, qualifier_text = _certainty(model_claim)
    event_date = model_claim.event_date.iso_date or model_claim.event_date.text
    connection.execute(
        "INSERT INTO evidence_claim_revisions "
        "(id, claim_id, revision_no, kind, review_state, fact_type, statement, plain_language, "
        "certainty, qualifier_text, event_date, extraction_run_id, candidate_ref, attested_by, "
        "supersedes_claim_id, citation_count, created_by, created_at) "
        "VALUES (?, ?, 1, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
        (
            str(revision_id),
            str(claim_id),
            model_claim.evidence_category.value,
            model_claim.fact_type.value,
            model_claim.statement,
            model_claim.plain_language,
            certainty,
            qualifier_text,
            event_date,
            run_id,
            model_claim.candidate_ref,
            len(model_claim.citations),
            created_by,
            now,
        ),
    )
    return ProposedClaim(
        revision_id=revision_id,
        claim_id=claim_id,
        statement=model_claim.statement,
        plain_language=model_claim.plain_language,
        kind=model_claim.evidence_category.value,
        certainty=certainty,
        qualifier_text=qualifier_text,
        citation_count=len(model_claim.citations),
    )


def _certainty(model_claim: ModelClaim) -> tuple[str, str | None]:
    if model_claim.source_qualifier != SourceQualifier.UNQUALIFIED:
        return (
            "qualified",
            model_claim.source_qualifier_text or model_claim.source_qualifier.value,
        )
    if model_claim.uncertainty.level != UncertaintyLevel.NONE:
        return "uncertain", None
    return "explicit", None


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())
