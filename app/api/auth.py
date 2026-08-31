import hmac
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.api.dependencies import auth_service as auth_service_dependency
from app.config import get_settings
from app.security.auth import AuthenticatedSession, AuthError, AuthErrorCode, AuthService
from app.security.tokens import SessionCookiePolicy

router = APIRouter(prefix="/api/auth", tags=["authentication"])
COOKIE = SessionCookiePolicy()
AuthServiceDependency = Annotated[AuthService, Depends(auth_service_dependency)]


class AuthRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetupRequest(AuthRequestModel):
    token: SecretStr
    password: SecretStr
    display_name: str = Field(min_length=1, max_length=120)
    household_name: str = Field(min_length=1, max_length=120)


class LoginRequest(AuthRequestModel):
    password: SecretStr


class RecoveryRequest(AuthRequestModel):
    recovery_code: SecretStr
    new_password: SecretStr


class UserResponse(BaseModel):
    id: str
    display_name: str
    role: str


class SessionResponse(BaseModel):
    authenticated: bool
    user: UserResponse | None = None
    csrf_token: str | None = None
    expires_at: int | None = None
    recovery_codes: tuple[str, ...] = ()


class ErrorResponse(BaseModel):
    error: str


@router.post(
    "/setup",
    response_model=SessionResponse,
    status_code=201,
    responses={401: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
def setup(
    payload: SetupRequest,
    request: Request,
    response: Response,
    service: AuthServiceDependency,
) -> SessionResponse | JSONResponse:
    if error := _same_origin_error(request):
        return error
    try:
        session = service.setup_owner(
            payload.token.get_secret_value(),
            payload.password.get_secret_value(),
            display_name=payload.display_name,
            household_name=payload.household_name,
        )
    except ValueError:
        return JSONResponse(status_code=422, content={"error": "INVALID_INPUT"})
    except AuthError as exc:
        return _auth_error(exc)
    _set_session_cookie(response, session)
    return _session_response(session)


@router.post(
    "/login",
    response_model=SessionResponse,
    responses={401: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    service: AuthServiceDependency,
) -> SessionResponse | JSONResponse:
    if error := _same_origin_error(request):
        return error
    try:
        session = service.login(payload.password.get_secret_value())
    except AuthError as exc:
        return _auth_error(exc)
    _set_session_cookie(response, session)
    return _session_response(session)


@router.get("/session", response_model=SessionResponse)
def session_status(
    request: Request,
    service: AuthServiceDependency,
) -> SessionResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return SessionResponse(authenticated=False)
    try:
        record = service.session(plaintext)
    except AuthError:
        return SessionResponse(authenticated=False)
    return SessionResponse(
        authenticated=True,
        user=UserResponse(
            id=str(record.user.id),
            display_name=record.user.display_name,
            role=record.user.role,
        ),
        csrf_token=service.issue_csrf(record),
        expires_at=record.expires_at,
    )


@router.post(
    "/recover",
    response_model=SessionResponse,
    responses={401: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
)
def recover(
    payload: RecoveryRequest,
    request: Request,
    response: Response,
    service: AuthServiceDependency,
) -> SessionResponse | JSONResponse:
    if error := _same_origin_error(request):
        return error
    try:
        recovered = service.recover(
            payload.recovery_code.get_secret_value(),
            payload.new_password.get_secret_value(),
        )
    except ValueError:
        return JSONResponse(status_code=422, content={"error": "INVALID_INPUT"})
    except AuthError as exc:
        return _auth_error(exc)
    _set_session_cookie(response, recovered)
    return _session_response(recovered)


@router.post("/logout", status_code=204, response_class=Response, response_model=None)
def logout(
    request: Request,
    service: AuthServiceDependency,
) -> Response | JSONResponse:
    if error := _same_origin_error(request):
        return error
    plaintext = request.cookies.get(COOKIE.name)
    csrf_token = request.headers.get("x-csrf-token", "")
    if not plaintext:
        return _auth_error(AuthError(AuthErrorCode.INVALID_SESSION))
    try:
        service.logout(plaintext, csrf_token)
    except AuthError as exc:
        return _auth_error(exc)
    response = Response(status_code=204)
    response.delete_cookie(
        COOKIE.name,
        path=COOKIE.path,
        secure=COOKIE.secure,
        httponly=COOKIE.http_only,
        samesite=COOKIE.same_site,
    )
    return response


def _session_response(session: AuthenticatedSession) -> SessionResponse:
    return SessionResponse(
        authenticated=True,
        user=UserResponse(
            id=str(session.user.id),
            display_name=session.user.display_name,
            role=session.user.role,
        ),
        csrf_token=session.csrf_token,
        expires_at=session.expires_at,
        recovery_codes=session.recovery_codes,
    )


def _set_session_cookie(response: Response, session: AuthenticatedSession) -> None:
    response.set_cookie(
        COOKIE.name,
        session.plaintext_token,
        max_age=COOKIE.max_age_seconds,
        path=COOKIE.path,
        secure=COOKIE.secure,
        httponly=COOKIE.http_only,
        samesite=COOKIE.same_site,
    )


def _same_origin_error(request: Request) -> JSONResponse | None:
    configured = urlsplit(get_settings().public_base_url)
    expected = f"{configured.scheme}://{configured.netloc}"
    origin = request.headers.get("origin", "")
    fetch_site = request.headers.get("sec-fetch-site")
    if not hmac.compare_digest(origin, expected) or fetch_site not in {None, "same-origin"}:
        return JSONResponse(status_code=403, content={"error": "ORIGIN_NOT_ALLOWED"})
    return None


def _auth_error(error: AuthError) -> JSONResponse:
    status = {
        AuthErrorCode.INVALID_SETUP: 401,
        AuthErrorCode.SETUP_ALREADY_COMPLETE: 409,
        AuthErrorCode.SETUP_REQUIRED: 409,
        AuthErrorCode.INVALID_CREDENTIALS: 401,
        AuthErrorCode.INVALID_SESSION: 401,
        AuthErrorCode.INVALID_CSRF: 403,
        AuthErrorCode.TRY_LATER: 429,
    }[error.code]
    headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
    return JSONResponse(status_code=status, content={"error": error.code.value}, headers=headers)
