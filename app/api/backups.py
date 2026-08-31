import hmac
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, SecretStr

from app.api.dependencies import backup_service
from app.backups.service import BackupService
from app.config import get_settings
from app.security.auth import AuthError, AuthErrorCode
from app.security.tokens import SessionCookiePolicy
from app.storage.portable_backup import BackupRejected

router = APIRouter(prefix="/api", tags=["backups"])
COOKIE = SessionCookiePolicy()
BackupDependency = Annotated[BackupService, Depends(backup_service)]


class BackupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    account_password: SecretStr
    backup_passphrase: SecretStr


@router.post(
    "/backups/export",
    response_class=FileResponse,
    response_model=None,
)
def export_backup(
    payload: BackupRequest,
    request: Request,
    service: BackupDependency,
) -> FileResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        exported = service.export(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            payload.account_password.get_secret_value(),
            payload.backup_passphrase.get_secret_value(),
        )
    except AuthError as error:
        return _auth_error(error)
    except (BackupRejected, ValueError):
        return _error(422, "BACKUP_REJECTED")
    return FileResponse(
        exported.path,
        media_type="application/octet-stream",
        filename="careledger-backup.clb",
        headers={"Cache-Control": "no-store"},
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


def _auth_error(error: AuthError) -> JSONResponse:
    status = 403 if error.code == AuthErrorCode.INVALID_CSRF else 401
    if error.code == AuthErrorCode.TRY_LATER:
        status = 429
    headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
    return JSONResponse(
        status_code=status,
        content={"error": error.code.value},
        headers=headers,
    )


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code})
