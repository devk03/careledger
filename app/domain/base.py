from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class DomainModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


def new_id() -> UUID:
    return uuid4()


def utc_now() -> datetime:
    return datetime.now(UTC)


class RevisionStamp(DomainModel):
    id: UUID = Field(default_factory=new_id)
    created_at: datetime = Field(default_factory=utc_now)
    created_by: UUID
