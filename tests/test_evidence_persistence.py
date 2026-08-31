import hashlib
import json
from pathlib import Path
from uuid import UUID

import pytest

from app.ai.contracts import ExtractionPayload
from app.ai.inputs import PageContext
from app.ai.prompts import PROMPT_VERSION, prompt_sha256
from app.ai.schema import schema_sha256
from app.ai.service import RunProvenance, ValidatedExtraction
from app.evidence.persistence import EvidencePersistence
from app.evidence.review import (
    EvidenceReviewService,
    ReviewDecision,
    ReviewError,
    ReviewErrorCode,
)
from app.search.service import EvidenceSearchService
from app.security.audit import verify_audit_chain
from app.security.auth import AuthService
from app.security.bootstrap import BootstrapManager
from app.security.tokens import hash_session_token, issue_csrf_token
from app.storage.database import Database

SOURCE_SHA256 = "a" * 64
ARTIFACT_SHA256 = "b" * 64
HOUSEHOLD_ID = "00000000-0000-0000-0000-000000000010"
USER_ID = "00000000-0000-0000-0000-000000000020"
PROFILE_ID = "00000000-0000-0000-0000-000000000030"
DOCUMENT_ID = "00000000-0000-0000-0000-000000000040"
SESSION_ID = UUID("00000000-0000-0000-0000-000000000050")
SESSION_TOKEN = "synthetic-session-token"  # noqa: S105 - synthetic test credential
CSRF_SECRET = b"c" * 32


def _database(tmp_path: Path) -> Database:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO households (singleton, id, display_name, created_at) "
            "VALUES (1, ?, 'Synthetic household', 1)",
            (HOUSEHOLD_ID,),
        )
        connection.execute(
            "INSERT INTO users "
            "(id, household_id, login_name, login_name_normalized, display_name, role, status, "
            "password_hash, auth_version, created_at, updated_at, password_changed_at, "
            "disabled_at) VALUES (?, ?, 'owner', 'owner', 'Synthetic organizer', 'owner', "
            "'active', '$argon2id$synthetic', 1, 1, 1, 1, NULL)",
            (USER_ID, HOUSEHOLD_ID),
        )
        connection.execute(
            "INSERT INTO care_profiles "
            "(id, household_id, preferred_name, birth_date, created_by, created_at, updated_at, "
            "archived_at) VALUES (?, ?, 'Synthetic loved one', NULL, ?, 1, 1, NULL)",
            (PROFILE_ID, HOUSEHOLD_ID, USER_ID),
        )
        connection.execute(
            "INSERT INTO source_objects (sha256, byte_size, media_type, created_at) "
            "VALUES (?, 12, 'image/png', 1)",
            (SOURCE_SHA256,),
        )
        connection.execute(
            "INSERT INTO documents "
            "(id, care_profile_id, source_sha256, original_display_name, scan_verdict, page_count, "
            "status, uploaded_by, uploaded_at, archived_at) VALUES "
            "(?, ?, ?, 'synthetic.png', 'clean', 1, 'ready', ?, 1, NULL)",
            (DOCUMENT_ID, PROFILE_ID, SOURCE_SHA256, USER_ID),
        )
        connection.execute(
            "INSERT INTO document_pages (document_id, page_number, created_at) VALUES (?, 1, 1)",
            (DOCUMENT_ID,),
        )
        connection.execute(
            "INSERT INTO derived_artifacts "
            "(id, document_id, page_number, kind, sha256, byte_size, media_type, storage_key, "
            "generator_version, created_at) VALUES ('artifact-test', ?, 1, "
            "'normalized_input', ?, 12, 'image/png', 'objects/synthetic', 'synthetic.v1', 1)",
            (DOCUMENT_ID, ARTIFACT_SHA256),
        )
        connection.execute(
            "INSERT INTO sessions "
            "(id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, "
            "last_seen_at, revoked_at) VALUES (?, ?, ?, ?, 1, 1, 9999999999, 1, NULL)",
            (
                str(SESSION_ID),
                USER_ID,
                hash_session_token(SESSION_TOKEN),
                CSRF_SECRET,
            ),
        )
    return database


def _extraction() -> ValidatedExtraction:
    payload = ExtractionPayload.model_validate_json(
        json.dumps(
            {
                "contract_version": "careledger.record_extraction.v1",
                "batch_token": "synthetic-batch",
                "page_assessments": [
                    {"page_number": 1, "has_relevant_content": True, "notes": None}
                ],
                "claims": [
                    {
                        "candidate_ref": "claim-1",
                        "fact_type": "imaging_finding",
                        "statement": "A possible synthetic finding is documented.",
                        "plain_language": (
                            "The source says this may be present, but it is uncertain."
                        ),
                        "evidence_category": "clinician_interpretation",
                        "source_qualifier": "possible",
                        "source_qualifier_text": "possible",
                        "event_date": {
                            "text": "Synthetic date",
                            "iso_date": None,
                            "precision": "unknown",
                            "kind": "report",
                        },
                        "uncertainty": {"level": "none", "reasons": [], "note": None},
                        "citations": [
                            {
                                "page_number": 1,
                                "quote": "A possible synthetic finding is documented.",
                                "bbox": None,
                            }
                        ],
                    }
                ],
            }
        ),
        strict=True,
    )
    return ValidatedExtraction(
        provenance=RunProvenance(
            contract_version=payload.contract_version,
            prompt_version=PROMPT_VERSION,
            prompt_sha256=prompt_sha256(),
            schema_sha256=schema_sha256(),
            request_sha256=hashlib.sha256(b"synthetic-request").hexdigest(),
            requested_model="synthetic-model",
            response_model="synthetic-model",
            openai_sdk_version="synthetic-sdk",
            source_sha256=SOURCE_SHA256,
            transmitted_sha256=SOURCE_SHA256,
            page_artifact_sha256=(ARTIFACT_SHA256,),
            batch_token="synthetic-batch",  # noqa: S106 - explicitly synthetic test value
            response_id="synthetic-response",
            response_created_at=2,
            usage={"input_tokens": 10, "output_tokens": 5},
        ),
        payload=payload,
    )


def test_validated_extraction_persists_only_proposed_source_linked_claims(
    tmp_path: Path,
) -> None:
    database = _database(tmp_path)
    proposals = EvidencePersistence(database).store_validated(
        document_id=UUID(DOCUMENT_ID),
        created_by=UUID(USER_ID),
        provider="synthetic-provider",
        extraction=_extraction(),
        pages=(PageContext(1, None, ARTIFACT_SHA256),),
        now=2,
    )

    assert len(proposals) == 1
    assert proposals[0].kind == "clinician_interpretation"
    assert proposals[0].certainty == "qualified"
    assert proposals[0].qualifier_text == "possible"
    assert proposals[0].citation_count == 1

    with database.connect(read_only=True) as connection:
        revision = connection.execute(
            "SELECT review_state, statement, citation_count, extraction_run_id "
            "FROM evidence_claim_revisions"
        ).fetchone()
        citation = connection.execute(
            "SELECT document_id, source_sha256, page_number, quote FROM citations"
        ).fetchone()
        run = connection.execute(
            "SELECT status, provider, payload_sha256, payload_json FROM extraction_runs"
        ).fetchone()
        document = connection.execute(
            "SELECT status FROM documents WHERE id = ?",
            (DOCUMENT_ID,),
        ).fetchone()
        audit = verify_audit_chain(connection)

    assert revision is not None and revision["review_state"] == "proposed"
    assert revision["statement"] == "A possible synthetic finding is documented."
    assert revision["citation_count"] == 1
    assert revision["extraction_run_id"] is not None
    assert citation is not None and citation["document_id"] == DOCUMENT_ID
    assert citation["source_sha256"] == SOURCE_SHA256
    assert citation["page_number"] == 1
    assert citation["quote"] == "A possible synthetic finding is documented."
    assert run is not None and run["status"] == "validated"
    assert run["provider"] == "synthetic-provider"
    assert hashlib.sha256(run["payload_json"].encode()).hexdigest() == run["payload_sha256"]
    assert document is not None and document["status"] == "needs_review"
    assert audit.ok is True


def test_human_review_creates_an_immutable_revision_and_completes_document(
    tmp_path: Path,
) -> None:
    database = _database(tmp_path)
    proposal = EvidencePersistence(database).store_validated(
        document_id=UUID(DOCUMENT_ID),
        created_by=UUID(USER_ID),
        provider="synthetic-provider",
        extraction=_extraction(),
        pages=(PageContext(1, None, ARTIFACT_SHA256),),
        now=2,
    )[0]
    auth = AuthService(
        database,
        BootstrapManager(tmp_path / "secrets", "https://localhost:8080"),
        b"r" * 32,
    )
    review = EvidenceReviewService(database, auth)

    listed = review.list_proposals(SESSION_TOKEN, UUID(DOCUMENT_ID))
    assert len(listed) == 1
    assert listed[0].revision_id == proposal.revision_id
    assert listed[0].citations[0].page_number == 1

    result = review.review(
        SESSION_TOKEN,
        issue_csrf_token(SESSION_ID, CSRF_SECRET),
        proposal.revision_id,
        ReviewDecision.ACCEPTED,
        now=3,
    )

    assert result.review_state == "accepted"
    assert result.document_status == "complete"
    assert review.list_proposals(SESSION_TOKEN, UUID(DOCUMENT_ID)) == ()
    search_results = EvidenceSearchService(database, auth).search(
        SESSION_TOKEN,
        UUID(PROFILE_ID),
        "possible synthetic",
    )
    assert len(search_results) == 1
    assert search_results[0].document_id == UUID(DOCUMENT_ID)
    assert search_results[0].page_number == 1
    with pytest.raises(ReviewError) as repeated:
        review.review(
            SESSION_TOKEN,
            issue_csrf_token(SESSION_ID, CSRF_SECRET),
            proposal.revision_id,
            ReviewDecision.REJECTED,
            now=4,
        )
    assert repeated.value.code == ReviewErrorCode.PROPOSAL_ALREADY_REVIEWED

    with database.connect(read_only=True) as connection:
        revisions = connection.execute(
            "SELECT revision_no, review_state, extraction_run_id, citation_count "
            "FROM evidence_claim_revisions ORDER BY revision_no"
        ).fetchall()
        citations = connection.execute(
            "SELECT claim_revision_id, quote FROM citations ORDER BY claim_revision_id"
        ).fetchall()
        document = connection.execute(
            "SELECT status FROM documents WHERE id = ?",
            (DOCUMENT_ID,),
        ).fetchone()
        audit = verify_audit_chain(connection)

    assert [row["review_state"] for row in revisions] == ["proposed", "accepted"]
    assert revisions[0]["extraction_run_id"] is not None
    assert revisions[1]["extraction_run_id"] is None
    assert all(row["citation_count"] == 1 for row in revisions)
    assert len(citations) == 2
    assert citations[0]["quote"] == citations[1]["quote"]
    assert document is not None and document["status"] == "complete"
    assert audit.ok is True
