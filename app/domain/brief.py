from pydantic import model_validator

from app.domain.base import DomainModel
from app.domain.evidence import EvidenceClaim, EvidenceKind, ReviewState
from app.domain.workflow import FollowUp, WorkflowState


class CareBrief(DomainModel):
    what_we_know: tuple[EvidenceClaim, ...]
    what_this_means: tuple[EvidenceClaim, ...]
    what_remains_unknown: tuple[EvidenceClaim, ...]
    what_to_do_next: tuple[FollowUp, ...]

    @model_validator(mode="after")
    def accepted_patient_facts_only(self) -> "CareBrief":
        for claim in (*self.what_we_know, *self.what_this_means):
            if claim.review_state != ReviewState.ACCEPTED:
                raise ValueError("brief facts must be human accepted")
            if claim.kind in {EvidenceKind.AGENT_INFERENCE, EvidenceKind.RESEARCH_CONTEXT}:
                raise ValueError("research and agent inference are not patient facts")
        return self


def build_care_brief(
    claims: tuple[EvidenceClaim, ...],
    follow_ups: tuple[FollowUp, ...],
) -> CareBrief:
    accepted = tuple(claim for claim in claims if claim.review_state == ReviewState.ACCEPTED)
    known = tuple(
        claim
        for claim in accepted
        if claim.kind
        in {
            EvidenceKind.SOURCE_DOCUMENTED_FACT,
            EvidenceKind.USER_ATTESTED_CONFIRMED_FACT,
        }
    )
    interpretations = tuple(
        claim for claim in accepted if claim.kind == EvidenceKind.CLINICIAN_INTERPRETATION
    )
    unknowns = tuple(
        claim
        for claim in claims
        if claim.kind == EvidenceKind.UNCONFIRMED_RECOLLECTION
        and claim.review_state in {ReviewState.PROPOSED, ReviewState.ACCEPTED}
    )
    next_steps = tuple(
        follow_up
        for follow_up in follow_ups
        if follow_up.state not in {WorkflowState.COMPLETED, WorkflowState.CANCELLED}
    )
    return CareBrief(
        what_we_know=known,
        what_this_means=interpretations,
        what_remains_unknown=unknowns,
        what_to_do_next=next_steps,
    )
