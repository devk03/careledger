import hashlib
from datetime import date
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.domain.base import RevisionStamp
from app.domain.brief import build_care_brief
from app.domain.evidence import (
    Certainty,
    Citation,
    EvidenceClaim,
    EvidenceKind,
    ReviewState,
)
from app.domain.workflow import FollowUp, WorkflowSource, WorkflowState


def _revision(actor_id: UUID) -> RevisionStamp:
    return RevisionStamp(created_by=actor_id)


def _citation() -> Citation:
    return Citation(
        document_id=uuid4(),
        source_sha256=hashlib.sha256(b"synthetic source").hexdigest(),
        page_number=1,
        quote="SYNTHETIC TEST RECORD - NOT A REAL PATIENT",
        bbox=None,
    )


def test_source_claim_cannot_enter_domain_without_citation() -> None:
    actor_id = uuid4()
    with pytest.raises(ValidationError, match="require citations"):
        EvidenceClaim(
            care_profile_id=uuid4(),
            kind=EvidenceKind.SOURCE_DOCUMENTED_FACT,
            review_state=ReviewState.ACCEPTED,
            statement="Synthetic finding.",
            plain_language="A synthetic finding was recorded.",
            certainty=Certainty.EXPLICIT,
            qualifier_text=None,
            event_date=date(2026, 1, 1),
            revision=_revision(actor_id),
        )


def test_user_attested_fact_requires_named_caregiver_but_not_document() -> None:
    actor_id = uuid4()
    claim = EvidenceClaim(
        care_profile_id=uuid4(),
        kind=EvidenceKind.USER_ATTESTED_CONFIRMED_FACT,
        review_state=ReviewState.ACCEPTED,
        statement="The synthetic appointment is scheduled.",
        plain_language=None,
        certainty=Certainty.EXPLICIT,
        qualifier_text=None,
        event_date=date(2026, 1, 2),
        citations=(),
        attested_by=actor_id,
        revision=_revision(actor_id),
    )
    assert claim.attested_by == actor_id


def test_agent_inference_can_never_be_accepted_as_patient_fact() -> None:
    actor_id = uuid4()
    with pytest.raises(ValidationError, match="cannot become an accepted"):
        EvidenceClaim(
            care_profile_id=uuid4(),
            kind=EvidenceKind.AGENT_INFERENCE,
            review_state=ReviewState.ACCEPTED,
            statement="Synthetic inference.",
            plain_language=None,
            certainty=Certainty.UNCERTAIN,
            qualifier_text=None,
            event_date=None,
            revision=_revision(actor_id),
        )


def test_brief_separates_known_interpreted_unknown_and_next() -> None:
    actor_id = uuid4()
    profile_id = uuid4()
    base: dict[str, Any] = {
        "care_profile_id": profile_id,
        "review_state": ReviewState.ACCEPTED,
        "plain_language": None,
        "event_date": None,
        "attested_by": None,
        "revision": _revision(actor_id),
    }
    known = EvidenceClaim(
        **base,
        kind=EvidenceKind.SOURCE_DOCUMENTED_FACT,
        statement="Synthetic test value was recorded.",
        certainty=Certainty.EXPLICIT,
        qualifier_text=None,
        citations=(_citation(),),
    )
    interpretation = EvidenceClaim(
        **base,
        kind=EvidenceKind.CLINICIAN_INTERPRETATION,
        statement="The synthetic report says a finding is possible.",
        certainty=Certainty.QUALIFIED,
        qualifier_text="possible",
        citations=(_citation(),),
    )
    unknown = EvidenceClaim(
        **base,
        kind=EvidenceKind.UNCONFIRMED_RECOLLECTION,
        statement="A result may still be pending.",
        certainty=Certainty.UNCERTAIN,
        qualifier_text=None,
    )
    follow_up = FollowUp(
        care_profile_id=profile_id,
        title="Ask when the synthetic result will be available",
        source=WorkflowSource.CAREGIVER_TASK,
        state=WorkflowState.OPEN,
        owner_id=actor_id,
        due_date=date(2026, 1, 3),
        source_claim_ids=(),
        revision=_revision(actor_id),
    )

    brief = build_care_brief((known, interpretation, unknown), (follow_up,))

    assert brief.what_we_know == (known,)
    assert brief.what_this_means == (interpretation,)
    assert brief.what_remains_unknown == (unknown,)
    assert brief.what_to_do_next == (follow_up,)
