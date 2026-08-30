import hashlib
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from app.domain.appointment import build_appointment_brief, render_appointment_markdown
from app.domain.base import RevisionStamp
from app.domain.brief import build_care_brief
from app.domain.evidence import (
    Certainty,
    Citation,
    EvidenceClaim,
    EvidenceKind,
    ReviewState,
)
from app.domain.workflow import (
    FollowUp,
    Question,
    QuestionPriority,
    WorkflowSource,
    WorkflowState,
)


def _revision(actor_id: UUID) -> RevisionStamp:
    return RevisionStamp(created_by=actor_id)


def test_appointment_brief_keeps_sources_and_plain_language_visible() -> None:
    actor_id = uuid4()
    profile_id = uuid4()
    document_id = uuid4()
    claim = EvidenceClaim(
        care_profile_id=profile_id,
        kind=EvidenceKind.SOURCE_DOCUMENTED_FACT,
        review_state=ReviewState.ACCEPTED,
        statement="SYNTHETIC TEST RECORD - NOT A REAL PATIENT.",
        plain_language="This is a fictional test statement.",
        certainty=Certainty.EXPLICIT,
        qualifier_text=None,
        event_date=date(2026, 2, 1),
        citations=(
            Citation(
                document_id=document_id,
                source_sha256=hashlib.sha256(b"synthetic record").hexdigest(),
                page_number=2,
                quote="SYNTHETIC TEST RECORD - NOT A REAL PATIENT.",
                bbox=None,
            ),
        ),
        revision=_revision(actor_id),
    )
    follow_up = FollowUp(
        care_profile_id=profile_id,
        title="Ask when the synthetic result will be ready",
        source=WorkflowSource.CAREGIVER_TASK,
        state=WorkflowState.OPEN,
        owner_id=actor_id,
        due_date=date(2026, 2, 3),
        source_claim_ids=(),
        revision=_revision(actor_id),
    )
    question = Question(
        care_profile_id=profile_id,
        text="What does the synthetic phrase mean?",
        priority=QuestionPriority.AT_NEXT_VISIT,
        state=WorkflowState.OPEN,
        owner_id=actor_id,
        due_date=None,
        answer=None,
        revision=_revision(actor_id),
    )
    before_visit = question.model_copy(
        update={
            "text": "What should be completed before the synthetic visit?",
            "priority": QuestionPriority.BEFORE_NEXT_VISIT,
        }
    )
    when_possible = question.model_copy(
        update={
            "text": "What can wait until later?",
            "priority": QuestionPriority.WHEN_POSSIBLE,
        }
    )
    care_brief = build_care_brief((claim,), (follow_up,))
    generated_at = datetime(2026, 2, 2, 12, tzinfo=UTC)

    appointment = build_appointment_brief(
        care_brief,
        (when_possible, question, before_visit),
        (),
        generated_at=generated_at,
    )
    markdown = render_appointment_markdown(appointment)

    assert "Preparation aid only" in markdown
    assert f"document {document_id}, page 2" in markdown
    assert "This is a fictional test statement" in markdown
    assert "What does the synthetic phrase mean?" in markdown
    assert "Ask when the synthetic result will be ready" in markdown
    assert [item.priority for item in appointment.questions] == [
        QuestionPriority.BEFORE_NEXT_VISIT.value,
        QuestionPriority.AT_NEXT_VISIT.value,
        QuestionPriority.WHEN_POSSIBLE.value,
    ]


def test_markdown_escapes_document_supplied_formatting() -> None:
    actor_id = uuid4()
    profile_id = uuid4()
    claim = EvidenceClaim(
        care_profile_id=profile_id,
        kind=EvidenceKind.USER_ATTESTED_CONFIRMED_FACT,
        review_state=ReviewState.ACCEPTED,
        statement="[Synthetic link](https://invalid.example) *not formatting*",
        plain_language=None,
        certainty=Certainty.EXPLICIT,
        qualifier_text=None,
        event_date=None,
        citations=(),
        attested_by=actor_id,
        revision=_revision(actor_id),
    )
    markdown = render_appointment_markdown(
        build_appointment_brief(
            build_care_brief((claim,), ()),
            (),
            (),
            generated_at=datetime(2026, 2, 2, tzinfo=UTC),
        )
    )

    assert "\\[Synthetic link\\]" in markdown
    assert "\\*not formatting\\*" in markdown
    assert "family-confirmed update" in markdown
