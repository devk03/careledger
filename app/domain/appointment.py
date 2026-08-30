import re
from datetime import UTC, date, datetime
from enum import StrEnum
from uuid import UUID

from app.domain.base import DomainModel
from app.domain.brief import CareBrief
from app.domain.evidence import EvidenceClaim, EvidenceKind
from app.domain.workflow import Decision, Question, QuestionPriority, WorkflowState

_QUESTION_PRIORITY_ORDER = {
    QuestionPriority.BEFORE_NEXT_VISIT: 0,
    QuestionPriority.AT_NEXT_VISIT: 1,
    QuestionPriority.WHEN_POSSIBLE: 2,
}


class BriefSourceKind(StrEnum):
    DOCUMENT_PAGE = "document_page"
    FAMILY_CONFIRMED = "family_confirmed"
    UNCONFIRMED_RECOLLECTION = "unconfirmed_recollection"


class BriefSource(DomainModel):
    kind: BriefSourceKind
    document_id: UUID | None
    page_number: int | None


class BriefEvidenceItem(DomainModel):
    statement: str
    plain_language: str | None
    sources: tuple[BriefSource, ...]


class BriefQuestion(DomainModel):
    text: str
    priority: str
    owner_id: UUID | None
    due_date: date | None


class BriefDecision(DomainModel):
    title: str
    decided_at: datetime
    rationale: str | None


class BriefNextStep(DomainModel):
    title: str
    source: str
    owner_id: UUID | None
    due_date: date | None


class AppointmentBrief(DomainModel):
    generated_at: datetime
    what_we_know: tuple[BriefEvidenceItem, ...]
    what_this_means: tuple[BriefEvidenceItem, ...]
    what_remains_unknown: tuple[BriefEvidenceItem, ...]
    questions: tuple[BriefQuestion, ...]
    recent_decisions: tuple[BriefDecision, ...]
    next_steps: tuple[BriefNextStep, ...]


def build_appointment_brief(
    care_brief: CareBrief,
    questions: tuple[Question, ...],
    decisions: tuple[Decision, ...],
    *,
    generated_at: datetime | None = None,
) -> AppointmentBrief:
    open_questions = sorted(
        (
            question
            for question in questions
            if question.state not in {WorkflowState.COMPLETED, WorkflowState.CANCELLED}
        ),
        key=lambda item: (
            _QUESTION_PRIORITY_ORDER[item.priority],
            item.due_date or date.max,
            item.text.casefold(),
        ),
    )
    recent_decisions = sorted(decisions, key=lambda item: item.decided_at, reverse=True)
    return AppointmentBrief(
        generated_at=generated_at or datetime.now(UTC),
        what_we_know=tuple(_evidence_item(claim) for claim in care_brief.what_we_know),
        what_this_means=tuple(_evidence_item(claim) for claim in care_brief.what_this_means),
        what_remains_unknown=tuple(
            _evidence_item(claim) for claim in care_brief.what_remains_unknown
        ),
        questions=tuple(
            BriefQuestion(
                text=question.text,
                priority=question.priority.value,
                owner_id=question.owner_id,
                due_date=question.due_date,
            )
            for question in open_questions
        ),
        recent_decisions=tuple(
            BriefDecision(
                title=decision.title,
                decided_at=decision.decided_at,
                rationale=decision.rationale,
            )
            for decision in recent_decisions
        ),
        next_steps=tuple(
            BriefNextStep(
                title=follow_up.title,
                source=follow_up.source.value,
                owner_id=follow_up.owner_id,
                due_date=follow_up.due_date,
            )
            for follow_up in care_brief.what_to_do_next
        ),
    )


def render_appointment_markdown(brief: AppointmentBrief) -> str:
    lines = [
        "# Appointment brief",
        "",
        f"Prepared: {brief.generated_at.date().isoformat()}",
        "",
        "> Preparation aid only — not medical advice.",
        "",
    ]
    _append_evidence(lines, "What we know", brief.what_we_know)
    _append_evidence(lines, "What the records may mean", brief.what_this_means)
    _append_evidence(lines, "What remains unknown", brief.what_remains_unknown)

    lines.extend(["## Questions to ask", ""])
    if not brief.questions:
        lines.append("- No open questions recorded.")
    for question in brief.questions:
        due = f"; due {question.due_date.isoformat()}" if question.due_date else ""
        lines.append(f"- {_escape(question.text)} ({question.priority}{due})")
    lines.append("")

    lines.extend(["## Recent decisions", ""])
    if not brief.recent_decisions:
        lines.append("- No decisions recorded.")
    for decision in brief.recent_decisions:
        rationale = f" — {_escape(decision.rationale)}" if decision.rationale else ""
        lines.append(
            f"- {decision.decided_at.date().isoformat()}: {_escape(decision.title)}{rationale}"
        )
    lines.append("")

    lines.extend(["## What to do next", ""])
    if not brief.next_steps:
        lines.append("- No open next steps recorded.")
    for step in brief.next_steps:
        due = f"; due {step.due_date.isoformat()}" if step.due_date else ""
        lines.append(f"- {_escape(step.title)} ({step.source}{due})")
    lines.append("")
    return "\n".join(lines)


def _evidence_item(claim: EvidenceClaim) -> BriefEvidenceItem:
    sources: tuple[BriefSource, ...]
    if claim.kind == EvidenceKind.USER_ATTESTED_CONFIRMED_FACT:
        sources = (
            BriefSource(
                kind=BriefSourceKind.FAMILY_CONFIRMED,
                document_id=None,
                page_number=None,
            ),
        )
    elif claim.kind == EvidenceKind.UNCONFIRMED_RECOLLECTION:
        sources = (
            BriefSource(
                kind=BriefSourceKind.UNCONFIRMED_RECOLLECTION,
                document_id=None,
                page_number=None,
            ),
        )
    else:
        sources = tuple(
            BriefSource(
                kind=BriefSourceKind.DOCUMENT_PAGE,
                document_id=citation.document_id,
                page_number=citation.page_number,
            )
            for citation in claim.citations
        )
    return BriefEvidenceItem(
        statement=claim.statement,
        plain_language=claim.plain_language,
        sources=sources,
    )


def _append_evidence(
    lines: list[str],
    heading: str,
    items: tuple[BriefEvidenceItem, ...],
) -> None:
    lines.extend([f"## {heading}", ""])
    if not items:
        lines.append("- Nothing recorded yet.")
    for item in items:
        source_text = "; ".join(_source_label(source) for source in item.sources)
        explanation = f" — {_escape(item.plain_language)}" if item.plain_language else ""
        lines.append(f"- {_escape(item.statement)}{explanation}  ")
        lines.append(f"  Source: {source_text}")
    lines.append("")


def _source_label(source: BriefSource) -> str:
    if source.kind == BriefSourceKind.FAMILY_CONFIRMED:
        return "family-confirmed update"
    if source.kind == BriefSourceKind.UNCONFIRMED_RECOLLECTION:
        return "unconfirmed family recollection"
    return f"document {source.document_id}, page {source.page_number}"


def _escape(value: str) -> str:
    one_line = re.sub(r"\s+", " ", value).strip()
    return re.sub(r"([\\`*_{}\[\]()#+.!|>-])", r"\\\1", one_line)
