from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api.dependencies import evidence_search_service
from app.search.service import EvidenceSearchService
from app.security.auth import AuthError, AuthErrorCode
from app.security.tokens import SessionCookiePolicy

router = APIRouter(prefix="/api", tags=["search"])
COOKIE = SessionCookiePolicy()
SearchDependency = Annotated[EvidenceSearchService, Depends(evidence_search_service)]


class SearchResultResponse(BaseModel):
    title: str
    body: str
    document_id: str | None
    page_number: int | None


@router.get(
    "/care-profiles/{profile_id}/search",
    response_model=tuple[SearchResultResponse, ...],
)
def search(
    profile_id: UUID,
    request: Request,
    service: SearchDependency,
    q: str = Query(min_length=1, max_length=200),
) -> tuple[SearchResultResponse, ...] | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return JSONResponse(
            status_code=401,
            content={"error": AuthErrorCode.INVALID_SESSION.value},
        )
    try:
        results = service.search(plaintext, profile_id, q)
    except AuthError:
        return JSONResponse(
            status_code=401,
            content={"error": AuthErrorCode.INVALID_SESSION.value},
        )
    except ValueError:
        return JSONResponse(status_code=422, content={"error": "INVALID_SEARCH"})
    return tuple(
        SearchResultResponse(
            title=result.title,
            body=result.body,
            document_id=str(result.document_id) if result.document_id else None,
            page_number=result.page_number,
        )
        for result in results
    )
