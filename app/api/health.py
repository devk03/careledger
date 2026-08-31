from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.dependencies import database as database_dependency
from app.config import get_settings
from app.storage.database import Database

router = APIRouter(tags=["system"])
DatabaseDependency = Annotated[Database, Depends(database_dependency)]


class HealthResponse(BaseModel):
    status: str


class SetupStatusResponse(BaseModel):
    setup_required: bool
    ai_available: bool


@router.get("/health/live", response_model=HealthResponse, include_in_schema=False)
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/health/ready", response_model=HealthResponse, include_in_schema=False)
def ready(database: DatabaseDependency) -> HealthResponse:
    settings = get_settings()
    settings.ensure_directories()
    database.verify()
    return HealthResponse(status="ready")


@router.get("/api/system/setup-status", response_model=SetupStatusResponse)
def setup_status(database: DatabaseDependency) -> SetupStatusResponse:
    settings = get_settings()
    return SetupStatusResponse(
        setup_required=not database.is_setup_complete(),
        ai_available=settings.ai_runtime().enabled,
    )
