import hmac
from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app.analysis.service import AnalysisError, AnalysisErrorCode, AnalysisService
from app.api.dependencies import analysis_service as analysis_service_dependency
from app.config import get_settings
from app.security.auth import AuthError, AuthErrorCode
from app.security.tokens import SessionCookiePolicy

router = APIRouter(prefix="/api", tags=["analysis"])
COOKIE = SessionCookiePolicy()
AnalysisServiceDependency = Annotated[AnalysisService, Depends(analysis_service_dependency)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class AnalysisRequest(RequestModel):
    acknowledge_external_transfer: bool


class AIStatusResponse(BaseModel):
    enabled: bool
    provider: str
    model: str | None
    external_transfer_required: bool


class AnalysisResponse(BaseModel):
    job_id: str
    state: str
    provider: str
    model: str
    already_requested: bool


@router.get("/ai/status", response_model=AIStatusResponse)
def ai_status(
    request: Request,
    service: AnalysisServiceDependency,
) -> AIStatusResponse | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        status = service.status(plaintext)
    except AuthError as error:
        return _auth_error(error)
    return AIStatusResponse(
        enabled=status.enabled,
        provider=status.provider,
        model=status.model,
        external_transfer_required=status.external_transfer_required,
    )


@router.post(
    "/documents/{document_id}/analysis",
    response_model=AnalysisResponse,
    status_code=202,
)
def request_analysis(
    document_id: UUID,
    payload: AnalysisRequest,
    request: Request,
    service: AnalysisServiceDependency,
) -> AnalysisResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    plaintext = request.cookies.get(COOKIE.name, "")
    csrf = request.headers.get("x-csrf-token", "")
    try:
        result = service.request_analysis(
            plaintext,
            csrf,
            document_id,
            acknowledge_external_transfer=payload.acknowledge_external_transfer,
        )
    except AuthError as error:
        return _auth_error(error)
    except AnalysisError as error:
        return _analysis_error(error)
    return AnalysisResponse(
        job_id=str(result.job_id),
        state=result.state,
        provider=result.provider,
        model=result.model,
        already_requested=result.already_requested,
    )


def _mutation_credentials(request: Request) -> JSONResponse | None:
    configured = urlsplit(get_settings().public_base_url)
    expected = f"{configured.scheme}://{configured.netloc}"
    origin = request.headers.get("origin", "")
    fetch_site = request.headers.get("sec-fetch-site")
    if not hmac.compare_digest(origin, expected) or fetch_site not in {None, "same-origin"}:
        return _error(403, "ORIGIN_NOT_ALLOWED")
    if not request.cookies.get(COOKIE.name):
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    if not request.headers.get("x-csrf-token"):
        return _error(403, AuthErrorCode.INVALID_CSRF.value)
    return None


def _analysis_error(error: AnalysisError) -> JSONResponse:
    statuses = {
        AnalysisErrorCode.AI_NOT_CONFIGURED: 409,
        AnalysisErrorCode.EXTERNAL_TRANSFER_NOT_CONFIRMED: 422,
        AnalysisErrorCode.DOCUMENT_NOT_FOUND: 404,
        AnalysisErrorCode.DOCUMENT_NOT_READY: 409,
    }
    return _error(statuses[error.code], error.code.value)


def _auth_error(error: AuthError) -> JSONResponse:
    status = 403 if error.code == AuthErrorCode.INVALID_CSRF else 401
    return _error(status, error.code.value)


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code})
