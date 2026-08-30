from datetime import date, datetime
from enum import StrEnum
from uuid import UUID

from pydantic import Field, model_validator

from app.domain.base import DomainModel, RevisionStamp, new_id


class WorkflowSource(StrEnum):
    CLINICIAN_INSTRUCTION = "clinician_instruction"
    CAREGIVER_TASK = "caregiver_task"
    AI_DRAFT = "ai_draft"


class WorkflowState(StrEnum):
    OPEN = "open"
    WAITING = "waiting"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class TimelineEvent(DomainModel):
    id: UUID = Field(default_factory=new_id)
    care_profile_id: UUID
    title: str
    occurred_at: datetime | None
    date_text: str | None
    source_claim_ids: tuple[UUID, ...]
    revision: RevisionStamp

    @model_validator(mode="after")
    def validate_event(self) -> "TimelineEvent":
        if not self.title.strip():
            raise ValueError("timeline title is required")
        if self.occurred_at is None and not (self.date_text or "").strip():
            raise ValueError("timeline events retain an exact or normalized date")
        if not self.source_claim_ids:
            raise ValueError("timeline events require accepted source claims")
        return self


class QuestionPriority(StrEnum):
    BEFORE_NEXT_VISIT = "before_next_visit"
    AT_NEXT_VISIT = "at_next_visit"
    WHEN_POSSIBLE = "when_possible"


class Question(DomainModel):
    id: UUID = Field(default_factory=new_id)
    care_profile_id: UUID
    text: str
    priority: QuestionPriority
    state: WorkflowState
    owner_id: UUID | None
    due_date: date | None
    answer: str | None
    answer_source_claim_ids: tuple[UUID, ...] = ()
    revision: RevisionStamp

    @model_validator(mode="after")
    def validate_question(self) -> "Question":
        if not self.text.strip():
            raise ValueError("question text is required")
        if self.answer is not None and not self.answer.strip():
            raise ValueError("an answer cannot be blank")
        if self.answer_source_claim_ids and self.answer is None:
            raise ValueError("answer sources require an answer")
        return self


class Decision(DomainModel):
    id: UUID = Field(default_factory=new_id)
    care_profile_id: UUID
    title: str
    decided_at: datetime
    decided_by: tuple[UUID, ...]
    rationale: str | None
    source_claim_ids: tuple[UUID, ...]
    revision: RevisionStamp

    @model_validator(mode="after")
    def validate_decision(self) -> "Decision":
        if not self.title.strip() or not self.decided_by:
            raise ValueError("a decision needs a title and decision maker")
        return self


class FollowUp(DomainModel):
    id: UUID = Field(default_factory=new_id)
    care_profile_id: UUID
    title: str
    source: WorkflowSource
    state: WorkflowState
    owner_id: UUID | None
    due_date: date | None
    source_claim_ids: tuple[UUID, ...]
    revision: RevisionStamp

    @model_validator(mode="after")
    def validate_follow_up(self) -> "FollowUp":
        if not self.title.strip():
            raise ValueError("follow-up title is required")
        if self.source == WorkflowSource.CLINICIAN_INSTRUCTION and not self.source_claim_ids:
            raise ValueError("clinician instructions require a cited source claim")
        if self.source == WorkflowSource.AI_DRAFT and self.state == WorkflowState.COMPLETED:
            raise ValueError("an AI draft must be confirmed before it can be completed")
        return self
