import hmac
from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import document_content_service as document_content_service_dependency
from app.api.dependencies import record_service as record_service_dependency
from app.config import get_settings
from app.ingest.models import UploadErrorCode, UploadRejected
from app.records.content import DocumentContentNotFound, DocumentContentService
from app.records.service import CareProfileRecord, DocumentRecord, RecordError, RecordService
from app.security.auth import AuthError, AuthErrorCode
from app.security.tokens import SessionCookiePolicy

router = APIRouter(prefix="/api", tags=["records"])
COOKIE = SessionCookiePolicy()
RecordServiceDependency = Annotated[RecordService, Depends(record_service_dependency)]
ContentServiceDependency = Annotated[
    DocumentContentService,
    Depends(document_content_service_dependency),
]
UploadDependency = Annotated[UploadFile, File()]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateProfileRequest(RequestModel):
    preferred_name: str = Field(min_length=1, max_length=120)


class CareProfileResponse(BaseModel):
    id: str
    preferred_name: str
    created_at: int


class DocumentResponse(BaseModel):
    id: str
    care_profile_id: str
    display_name: str
    media_type: str
    source_sha256: str
    byte_size: int
    page_count: int
    status: str
    scan_verdict: str
    uploaded_at: int
    job_id: str
    duplicate_source: bool


@router.get(
    "/documents/{document_id}/content",
    response_class=FileResponse,
    response_model=None,
)
def document_content(
    document_id: UUID,
    request: Request,
    service: ContentServiceDependency,
) -> FileResponse | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        content = service.open(plaintext, document_id)
    except AuthError as exc:
        return _auth_error(exc)
    except DocumentContentNotFound:
        return _error(404, "DOCUMENT_NOT_FOUND")
    return FileResponse(
        content.path,
        media_type=content.media_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": "inline",
            "ETag": f'"sha256-{content.source_sha256}"',
        },
    )


@router.get("/care-profiles", response_model=tuple[CareProfileResponse, ...])
def list_profiles(
    request: Request,
    service: RecordServiceDependency,
) -> tuple[CareProfileResponse, ...] | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        return tuple(_profile_response(profile) for profile in service.list_profiles(plaintext))
    except AuthError as exc:
        return _auth_error(exc)


@router.post("/care-profiles", response_model=CareProfileResponse, status_code=201)
def create_profile(
    payload: CreateProfileRequest,
    request: Request,
    service: RecordServiceDependency,
) -> CareProfileResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    plaintext, csrf = _tokens(request)
    try:
        profile = service.create_profile(plaintext, csrf, payload.preferred_name)
    except ValueError:
        return _error(422, "INVALID_INPUT")
    except AuthError as exc:
        return _auth_error(exc)
    return _profile_response(profile)


@router.get(
    "/care-profiles/{care_profile_id}/documents",
    response_model=tuple[DocumentResponse, ...],
)
def list_documents(
    care_profile_id: UUID,
    request: Request,
    service: RecordServiceDependency,
) -> tuple[DocumentResponse, ...] | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        return tuple(
            _document_response(document)
            for document in service.list_documents(plaintext, care_profile_id)
        )
    except AuthError as exc:
        return _auth_error(exc)
    except RecordError:
        return _error(404, "PROFILE_NOT_FOUND")


@router.post(
    "/care-profiles/{care_profile_id}/documents",
    response_model=DocumentResponse,
    status_code=201,
)
def upload_document(
    care_profile_id: UUID,
    request: Request,
    service: RecordServiceDependency,
    record: UploadDependency,
) -> DocumentResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    plaintext, csrf = _tokens(request)
    try:
        document = service.upload_document(
            plaintext,
            csrf,
            care_profile_id,
            record.file,
            original_name=record.filename or "record",
            claimed_media_type=record.content_type,
            content_length=record.size,
        )
    except AuthError as exc:
        return _auth_error(exc)
    except RecordError:
        return _error(404, "PROFILE_NOT_FOUND")
    except UploadRejected as exc:
        status = 413 if exc.code == UploadErrorCode.UPLOAD_TOO_LARGE else 422
        return JSONResponse(
            status_code=status,
            content={"error": exc.code.value, "message": exc.user_message},
        )
    return _document_response(document)


def _tokens(request: Request) -> tuple[str, str]:
    return (
        request.cookies.get(COOKIE.name, ""),
        request.headers.get("x-csrf-token", ""),
    )


def _mutation_credentials(request: Request) -> JSONResponse | None:
    configured = urlsplit(get_settings().public_base_url)
    expected = f"{configured.scheme}://{configured.netloc}"
    origin = request.headers.get("origin", "")
    fetch_site = request.headers.get("sec-fetch-site")
    plaintext, csrf = _tokens(request)
    if not hmac.compare_digest(origin, expected) or fetch_site not in {None, "same-origin"}:
        return _error(403, "ORIGIN_NOT_ALLOWED")
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    if not csrf:
        return _error(403, AuthErrorCode.INVALID_CSRF.value)
    return None


def _profile_response(profile: CareProfileRecord) -> CareProfileResponse:
    return CareProfileResponse(
        id=str(profile.id),
        preferred_name=profile.preferred_name,
        created_at=profile.created_at,
    )


def _document_response(document: DocumentRecord) -> DocumentResponse:
    return DocumentResponse(
        id=str(document.id),
        care_profile_id=str(document.care_profile_id),
        display_name=document.display_name,
        media_type=document.media_type,
        source_sha256=document.source_sha256,
        byte_size=document.byte_size,
        page_count=document.page_count,
        status=document.status,
        scan_verdict=document.scan_verdict,
        uploaded_at=document.uploaded_at,
        job_id=str(document.job_id),
        duplicate_source=document.duplicate_source,
    )


def _auth_error(error: AuthError) -> JSONResponse:
    status = 403 if error.code == AuthErrorCode.INVALID_CSRF else 401
    return _error(status, error.code.value)


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code})
