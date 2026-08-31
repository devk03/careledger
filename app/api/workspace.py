import hmac
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import care_workspace_service
from app.config import get_settings
from app.security.auth import AuthError, AuthErrorCode
from app.security.tokens import SessionCookiePolicy
from app.workspace.service import (
    CareDashboard,
    CareWorkspaceService,
    WorkspaceError,
    WorkspaceErrorCode,
)

router = APIRouter(prefix="/api", tags=["workspace"])
COOKIE = SessionCookiePolicy()
WorkspaceDependency = Annotated[CareWorkspaceService, Depends(care_workspace_service)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SourceResponse(BaseModel):
    document_id: str
    page_number: int


class ClaimResponse(BaseModel):
    claim_id: str
    statement: str
    plain_language: str | None
    kind: str
    event_date: str | None
    sources: tuple[SourceResponse, ...]


class QuestionResponse(BaseModel):
    id: str
    text: str
    priority: str
    state: str
    due_date: str | None


class FollowupResponse(BaseModel):
    id: str
    title: str
    source: str
    state: str
    due_date: str | None


class DecisionResponse(BaseModel):
    id: str
    title: str
    decided_at: int
    rationale: str | None


class DashboardResponse(BaseModel):
    profile_id: str
    preferred_name: str
    what_we_know: tuple[ClaimResponse, ...]
    what_this_means: tuple[ClaimResponse, ...]
    what_remains_unknown: tuple[ClaimResponse, ...]
    timeline: tuple[ClaimResponse, ...]
    questions: tuple[QuestionResponse, ...]
    followups: tuple[FollowupResponse, ...]
    decisions: tuple[DecisionResponse, ...]


class CreateQuestionRequest(RequestModel):
    text: str = Field(min_length=1, max_length=500)
    priority: Literal["before_next_visit", "at_next_visit", "when_possible"]
    due_date: str | None = None


class SetStateRequest(RequestModel):
    state: Literal["open", "waiting", "completed", "cancelled"]


class CreateFollowupRequest(RequestModel):
    title: str = Field(min_length=1, max_length=500)
    due_date: str | None = None


class CreateDecisionRequest(RequestModel):
    title: str = Field(min_length=1, max_length=500)
    rationale: str | None = Field(default=None, max_length=2_000)
    decided_at: int = Field(gt=0)


@router.get(
    "/care-profiles/{profile_id}/appointment-brief",
    response_class=PlainTextResponse,
    response_model=None,
)
def appointment_brief(
    profile_id: UUID,
    request: Request,
    service: WorkspaceDependency,
) -> PlainTextResponse | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        document = service.appointment_markdown(plaintext, profile_id)
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return PlainTextResponse(
        document,
        media_type="text/markdown",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'attachment; filename="appointment-brief.md"',
        },
    )


@router.get(
    "/care-profiles/{profile_id}/workspace",
    response_model=DashboardResponse,
)
def dashboard(
    profile_id: UUID,
    request: Request,
    service: WorkspaceDependency,
) -> DashboardResponse | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        result = service.dashboard(plaintext, profile_id)
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return _dashboard_response(result)


@router.post(
    "/care-profiles/{profile_id}/questions",
    response_model=QuestionResponse,
    status_code=201,
)
def create_question(
    profile_id: UUID,
    payload: CreateQuestionRequest,
    request: Request,
    service: WorkspaceDependency,
) -> QuestionResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        question = service.create_question(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            profile_id,
            text=payload.text,
            priority=payload.priority,
            due_date=payload.due_date,
        )
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return QuestionResponse(**question.__dict__ | {"id": str(question.id)})


@router.post("/questions/{question_id}/state", response_model=QuestionResponse)
def set_question_state(
    question_id: UUID,
    payload: SetStateRequest,
    request: Request,
    service: WorkspaceDependency,
) -> QuestionResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        question = service.set_question_state(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            question_id,
            payload.state,
        )
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return QuestionResponse(**question.__dict__ | {"id": str(question.id)})


@router.post(
    "/care-profiles/{profile_id}/followups",
    response_model=FollowupResponse,
    status_code=201,
)
def create_followup(
    profile_id: UUID,
    payload: CreateFollowupRequest,
    request: Request,
    service: WorkspaceDependency,
) -> FollowupResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        followup = service.create_followup(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            profile_id,
            title=payload.title,
            due_date=payload.due_date,
        )
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return FollowupResponse(**followup.__dict__ | {"id": str(followup.id)})


@router.post(
    "/care-profiles/{profile_id}/decisions",
    response_model=DecisionResponse,
    status_code=201,
)
def create_decision(
    profile_id: UUID,
    payload: CreateDecisionRequest,
    request: Request,
    service: WorkspaceDependency,
) -> DecisionResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        decision = service.create_decision(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            profile_id,
            title=payload.title,
            rationale=payload.rationale,
            decided_at=payload.decided_at,
        )
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return DecisionResponse(**decision.__dict__ | {"id": str(decision.id)})


@router.post("/followups/{followup_id}/state", response_model=FollowupResponse)
def set_followup_state(
    followup_id: UUID,
    payload: SetStateRequest,
    request: Request,
    service: WorkspaceDependency,
) -> FollowupResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        followup = service.set_followup_state(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            followup_id,
            payload.state,
        )
    except AuthError as error:
        return _auth_error(error)
    except WorkspaceError as error:
        return _workspace_error(error)
    return FollowupResponse(**followup.__dict__ | {"id": str(followup.id)})


def _dashboard_response(dashboard: CareDashboard) -> DashboardResponse:
    def claim(value: object) -> ClaimResponse:
        from app.workspace.service import SummaryClaim

        if not isinstance(value, SummaryClaim):
            raise TypeError("summary claim required")
        return ClaimResponse(
            claim_id=str(value.claim_id),
            statement=value.statement,
            plain_language=value.plain_language,
            kind=value.kind,
            event_date=value.event_date,
            sources=tuple(
                SourceResponse(document_id=str(source.document_id), page_number=source.page_number)
                for source in value.sources
            ),
        )

    return DashboardResponse(
        profile_id=str(dashboard.profile_id),
        preferred_name=dashboard.preferred_name,
        what_we_know=tuple(claim(value) for value in dashboard.what_we_know),
        what_this_means=tuple(claim(value) for value in dashboard.what_this_means),
        what_remains_unknown=tuple(claim(value) for value in dashboard.what_remains_unknown),
        timeline=tuple(claim(value) for value in dashboard.timeline),
        questions=tuple(
            QuestionResponse(**value.__dict__ | {"id": str(value.id)})
            for value in dashboard.questions
        ),
        followups=tuple(
            FollowupResponse(**value.__dict__ | {"id": str(value.id)})
            for value in dashboard.followups
        ),
        decisions=tuple(
            DecisionResponse(**value.__dict__ | {"id": str(value.id)})
            for value in dashboard.decisions
        ),
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


def _workspace_error(error: WorkspaceError) -> JSONResponse:
    status = (
        404
        if error.code in {WorkspaceErrorCode.PROFILE_NOT_FOUND, WorkspaceErrorCode.ITEM_NOT_FOUND}
        else 422
    )
    return _error(status, error.code.value)


def _auth_error(error: AuthError) -> JSONResponse:
    status = 403 if error.code == AuthErrorCode.INVALID_CSRF else 401
    return _error(status, error.code.value)


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code})
