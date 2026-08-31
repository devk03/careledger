import hashlib
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from app.security.auth import AuthService, append_audit_event
from app.storage.database import Database


class ReviewDecision(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class ReviewErrorCode(StrEnum):
    DOCUMENT_NOT_FOUND = "DOCUMENT_NOT_FOUND"
    PROPOSAL_NOT_FOUND = "PROPOSAL_NOT_FOUND"
    PROPOSAL_ALREADY_REVIEWED = "PROPOSAL_ALREADY_REVIEWED"


class ReviewError(RuntimeError):
    def __init__(self, code: ReviewErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class ClaimCitation:
    document_id: UUID
    page_number: int
    quote: str | None


@dataclass(frozen=True)
class ClaimProposal:
    revision_id: UUID
    claim_id: UUID
    statement: str
    plain_language: str | None
    kind: str
    fact_type: str | None
    certainty: str
    qualifier_text: str | None
    event_date: str | None
    citations: tuple[ClaimCitation, ...]


@dataclass(frozen=True)
class ReviewResult:
    revision_id: UUID
    claim_id: UUID
    review_state: str
    document_status: str


class EvidenceReviewService:
    def __init__(self, database: Database, auth: AuthService) -> None:
        self._database = database
        self._auth = auth

    def list_proposals(
        self,
        plaintext_token: str,
        document_id: UUID,
    ) -> tuple[ClaimProposal, ...]:
        session = self._auth.session(plaintext_token)
        with self._database.connect(read_only=True) as connection:
            if not _document_in_household(
                connection,
                document_id=str(document_id),
                household_id=str(session.household_id),
            ):
                raise ReviewError(ReviewErrorCode.DOCUMENT_NOT_FOUND)
            rows = connection.execute(
                "SELECT revision.id, revision.claim_id, revision.statement, "
                "revision.plain_language, revision.kind, revision.fact_type, "
                "revision.certainty, revision.qualifier_text, revision.event_date "
                "FROM current_evidence_claim_revisions AS revision "
                "JOIN extraction_runs ON extraction_runs.id = revision.extraction_run_id "
                "WHERE extraction_runs.document_id = ? AND revision.review_state = 'proposed' "
                "ORDER BY revision.created_at, revision.id",
                (str(document_id),),
            ).fetchall()
            return tuple(_proposal(connection, row) for row in rows)

    def review(
        self,
        plaintext_token: str,
        csrf_token: str,
        proposal_revision_id: UUID,
        decision: ReviewDecision,
        *,
        now: int | None = None,
    ) -> ReviewResult:
        timestamp = now or _now_epoch()
        new_revision_id = uuid4()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
            proposal = connection.execute(
                "SELECT revision.*, extraction_runs.document_id, evidence_claims.care_profile_id "
                "FROM evidence_claim_revisions AS revision "
                "JOIN evidence_claims ON evidence_claims.id = revision.claim_id "
                "JOIN care_profiles ON care_profiles.id = evidence_claims.care_profile_id "
                "JOIN extraction_runs ON extraction_runs.id = revision.extraction_run_id "
                "WHERE revision.id = ? AND care_profiles.household_id = ?",
                (str(proposal_revision_id), str(session.household_id)),
            ).fetchone()
            if proposal is None:
                raise ReviewError(ReviewErrorCode.PROPOSAL_NOT_FOUND)
            current = connection.execute(
                "SELECT id, review_state FROM current_evidence_claim_revisions "
                "WHERE claim_id = ?",
                (proposal["claim_id"],),
            ).fetchone()
            if (
                proposal["review_state"] != "proposed"
                or current is None
                or current["id"] != proposal["id"]
            ):
                raise ReviewError(ReviewErrorCode.PROPOSAL_ALREADY_REVIEWED)
            citations = connection.execute(
                "SELECT * FROM citations WHERE claim_revision_id = ? ORDER BY position",
                (proposal["id"],),
            ).fetchall()
            for citation in citations:
                connection.execute(
                    "INSERT INTO citations "
                    "(id, claim_revision_id, document_id, source_sha256, page_number, quote, "
                    "bbox_x0, bbox_y0, bbox_x1, bbox_y1, position) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(uuid4()),
                        str(new_revision_id),
                        citation["document_id"],
                        citation["source_sha256"],
                        citation["page_number"],
                        citation["quote"],
                        citation["bbox_x0"],
                        citation["bbox_y0"],
                        citation["bbox_x1"],
                        citation["bbox_y1"],
                        citation["position"],
                    ),
                )
            revision_no = int(
                connection.execute(
                    "SELECT MAX(revision_no) FROM evidence_claim_revisions WHERE claim_id = ?",
                    (proposal["claim_id"],),
                ).fetchone()[0]
            ) + 1
            connection.execute(
                "INSERT INTO evidence_claim_revisions "
                "(id, claim_id, revision_no, kind, review_state, fact_type, statement, "
                "plain_language, certainty, qualifier_text, event_date, extraction_run_id, "
                "candidate_ref, attested_by, supersedes_claim_id, citation_count, created_by, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, "
                "?, ?, ?)",
                (
                    str(new_revision_id),
                    proposal["claim_id"],
                    revision_no,
                    proposal["kind"],
                    decision.value,
                    proposal["fact_type"],
                    proposal["statement"],
                    proposal["plain_language"],
                    proposal["certainty"],
                    proposal["qualifier_text"],
                    proposal["event_date"],
                    len(citations),
                    str(session.user.id),
                    timestamp,
                ),
            )
            if decision == ReviewDecision.ACCEPTED:
                _index_accepted_claim(
                    connection,
                    care_profile_id=proposal["care_profile_id"],
                    revision_id=str(new_revision_id),
                    title=proposal["fact_type"] or "Reviewed fact",
                    statement=proposal["statement"],
                    plain_language=proposal["plain_language"],
                    document_id=proposal["document_id"],
                    page_number=int(citations[0]["page_number"]) if citations else None,
                    now=timestamp,
                )
            document_status = _finish_document_if_reviewed(
                connection,
                document_id=proposal["document_id"],
            )
            append_audit_event(
                connection,
                household_id=str(session.household_id),
                actor_user_id=str(session.user.id),
                action=f"evidence_{decision.value}",
                entity_kind="evidence_claim_revision",
                entity_id=str(new_revision_id),
                outcome="success",
                occurred_at=timestamp,
            )
        return ReviewResult(
            revision_id=new_revision_id,
            claim_id=UUID(proposal["claim_id"]),
            review_state=decision.value,
            document_status=document_status,
        )


def _document_in_household(
    connection: sqlite3.Connection,
    *,
    document_id: str,
    household_id: str,
) -> bool:
    row = connection.execute(
        "SELECT 1 FROM documents JOIN care_profiles "
        "ON care_profiles.id = documents.care_profile_id "
        "WHERE documents.id = ? AND care_profiles.household_id = ?",
        (document_id, household_id),
    ).fetchone()
    return row is not None


def _proposal(connection: sqlite3.Connection, row: sqlite3.Row) -> ClaimProposal:
    citations = connection.execute(
        "SELECT document_id, page_number, quote FROM citations "
        "WHERE claim_revision_id = ? ORDER BY position",
        (row["id"],),
    ).fetchall()
    return ClaimProposal(
        revision_id=UUID(row["id"]),
        claim_id=UUID(row["claim_id"]),
        statement=row["statement"],
        plain_language=row["plain_language"],
        kind=row["kind"],
        fact_type=row["fact_type"],
        certainty=row["certainty"],
        qualifier_text=row["qualifier_text"],
        event_date=row["event_date"],
        citations=tuple(
            ClaimCitation(
                document_id=UUID(citation["document_id"]),
                page_number=int(citation["page_number"]),
                quote=citation["quote"],
            )
            for citation in citations
        ),
    )


def _finish_document_if_reviewed(
    connection: sqlite3.Connection,
    *,
    document_id: str,
) -> str:
    remaining = int(
        connection.execute(
            "SELECT COUNT(*) FROM current_evidence_claim_revisions AS current "
            "WHERE current.review_state = 'proposed' AND EXISTS ("
            "SELECT 1 FROM evidence_claim_revisions AS source "
            "JOIN extraction_runs ON extraction_runs.id = source.extraction_run_id "
            "WHERE source.claim_id = current.claim_id AND extraction_runs.document_id = ?)",
            (document_id,),
        ).fetchone()[0]
    )
    status = "needs_review" if remaining else "complete"
    connection.execute("UPDATE documents SET status = ? WHERE id = ?", (status, document_id))
    return status


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())


def _index_accepted_claim(
    connection: sqlite3.Connection,
    *,
    care_profile_id: str,
    revision_id: str,
    title: str,
    statement: str,
    plain_language: str | None,
    document_id: str,
    page_number: int | None,
    now: int,
) -> None:
    body = statement if plain_language is None else f"{statement}\n{plain_language}"
    content_sha256 = hashlib.sha256(body.encode("utf-8")).hexdigest()
    cursor = connection.execute(
        "INSERT INTO search_entries "
        "(care_profile_id, entity_kind, entity_key, title, body, content_sha256, document_id, "
        "page_number, updated_at) VALUES (?, 'accepted_claim', ?, ?, ?, ?, ?, ?, ?)",
        (
            care_profile_id,
            revision_id,
            title,
            body,
            content_sha256,
            document_id,
            page_number,
            now,
        ),
    )
    connection.execute(
        "INSERT INTO search_entries_fts "
        "(rowid, title, body, care_profile_id, entity_kind, entity_key) "
        "VALUES (?, ?, ?, ?, 'accepted_claim', ?)",
        (cursor.lastrowid, title, body, care_profile_id, revision_id),
    )
