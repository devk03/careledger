from datetime import date
from enum import StrEnum
from uuid import UUID

from pydantic import Field, model_validator

from app.domain.base import DomainModel, RevisionStamp, new_id


class EvidenceKind(StrEnum):
    SOURCE_DOCUMENTED_FACT = "source_documented_fact"
    USER_ATTESTED_CONFIRMED_FACT = "user_attested_confirmed_fact"
    CLINICIAN_INTERPRETATION = "clinician_interpretation"
    UNCONFIRMED_RECOLLECTION = "unconfirmed_recollection"
    RESEARCH_CONTEXT = "research_context"
    AGENT_INFERENCE = "agent_inference"


class ReviewState(StrEnum):
    PROPOSED = "proposed"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class Certainty(StrEnum):
    EXPLICIT = "explicit"
    QUALIFIED = "qualified"
    UNCERTAIN = "uncertain"


class Citation(DomainModel):
    id: UUID = Field(default_factory=new_id)
    document_id: UUID
    source_sha256: str
    page_number: int
    quote: str | None
    bbox: tuple[float, float, float, float] | None

    @model_validator(mode="after")
    def validate_locator(self) -> "Citation":
        if self.page_number < 1:
            raise ValueError("citation page numbers are one-based")
        if len(self.source_sha256) != 64 or any(
            character not in "0123456789abcdef" for character in self.source_sha256
        ):
            raise ValueError("citation digest must be lowercase SHA-256")
        quote = self.quote.strip() if self.quote is not None else ""
        if not quote and self.bbox is None:
            raise ValueError("a citation needs an exact quote or bounding box")
        if self.bbox is not None:
            x0, y0, x1, y1 = self.bbox
            if not all(0 <= value <= 1 for value in self.bbox):
                raise ValueError("citation bounding boxes use normalized coordinates")
            if x0 >= x1 or y0 >= y1:
                raise ValueError("citation bounding box must have positive area")
        return self


class EvidenceClaim(DomainModel):
    id: UUID = Field(default_factory=new_id)
    care_profile_id: UUID
    kind: EvidenceKind
    review_state: ReviewState
    statement: str
    plain_language: str | None
    certainty: Certainty
    qualifier_text: str | None
    event_date: date | None
    citations: tuple[Citation, ...] = ()
    attested_by: UUID | None = None
    revision: RevisionStamp
    supersedes_claim_id: UUID | None = None

    @model_validator(mode="after")
    def validate_provenance(self) -> "EvidenceClaim":
        if not self.statement.strip():
            raise ValueError("claim statement is required")
        source_kinds = {
            EvidenceKind.SOURCE_DOCUMENTED_FACT,
            EvidenceKind.CLINICIAN_INTERPRETATION,
        }
        if self.kind in source_kinds and not self.citations:
            raise ValueError("source and clinician claims require citations")
        if self.kind == EvidenceKind.USER_ATTESTED_CONFIRMED_FACT and self.attested_by is None:
            raise ValueError("user-attested facts require the attesting caregiver")
        if self.kind != EvidenceKind.USER_ATTESTED_CONFIRMED_FACT and self.attested_by is not None:
            raise ValueError("attested_by belongs only to user-attested facts")
        if self.kind == EvidenceKind.AGENT_INFERENCE and self.review_state != ReviewState.PROPOSED:
            raise ValueError("agent inference cannot become an accepted patient fact")
        if self.certainty == Certainty.QUALIFIED and not (self.qualifier_text or "").strip():
            raise ValueError("qualified claims must preserve their qualifier text")
        if self.certainty != Certainty.QUALIFIED and self.qualifier_text is not None:
            raise ValueError("qualifier text is only valid for qualified claims")
        if self.review_state == ReviewState.SUPERSEDED and self.supersedes_claim_id is None:
            raise ValueError("superseded claims must identify the related claim")
        return self
