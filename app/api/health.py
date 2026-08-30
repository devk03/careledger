from fastapi import APIRouter
from pydantic import BaseModel

from app.config import get_settings

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: str


class SetupStatusResponse(BaseModel):
    setup_required: bool
    ai_available: bool


@router.get("/health/live", response_model=HealthResponse, include_in_schema=False)
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/health/ready", response_model=HealthResponse, include_in_schema=False)
def ready() -> HealthResponse:
    settings = get_settings()
    settings.ensure_directories()
    return HealthResponse(status="ready")


@router.get("/api/system/setup-status", response_model=SetupStatusResponse)
def setup_status() -> SetupStatusResponse:
    settings = get_settings()
    return SetupStatusResponse(
        setup_required=not (settings.secrets_dir / "bootstrap.completed").exists(),
        ai_available=bool(settings.openai_api_key),
    )
