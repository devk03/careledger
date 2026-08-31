import hmac
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app.api.dependencies import evidence_review_service
from app.config import get_settings
from app.evidence.review import (
    EvidenceReviewService,
    ReviewDecision,
    ReviewError,
    ReviewErrorCode,
)
from app.security.auth import AuthError, AuthErrorCode
from app.security.tokens import SessionCookiePolicy

router = APIRouter(prefix="/api", tags=["evidence"])
COOKIE = SessionCookiePolicy()
ReviewServiceDependency = Annotated[EvidenceReviewService, Depends(evidence_review_service)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CitationResponse(BaseModel):
    document_id: str
    page_number: int
    quote: str | None


class ProposalResponse(BaseModel):
    revision_id: str
    claim_id: str
    statement: str
    plain_language: str | None
    kind: str
    fact_type: str | None
    certainty: str
    qualifier_text: str | None
    event_date: str | None
    citations: tuple[CitationResponse, ...]


class ReviewRequest(RequestModel):
    decision: Literal["accepted", "rejected"]


class ReviewResponse(BaseModel):
    revision_id: str
    claim_id: str
    review_state: str
    document_status: str


@router.get(
    "/documents/{document_id}/proposals",
    response_model=tuple[ProposalResponse, ...],
)
def list_proposals(
    document_id: UUID,
    request: Request,
    service: ReviewServiceDependency,
) -> tuple[ProposalResponse, ...] | JSONResponse:
    plaintext = request.cookies.get(COOKIE.name)
    if not plaintext:
        return _error(401, AuthErrorCode.INVALID_SESSION.value)
    try:
        proposals = service.list_proposals(plaintext, document_id)
    except AuthError as error:
        return _auth_error(error)
    except ReviewError as error:
        return _review_error(error)
    return tuple(
        ProposalResponse(
            revision_id=str(proposal.revision_id),
            claim_id=str(proposal.claim_id),
            statement=proposal.statement,
            plain_language=proposal.plain_language,
            kind=proposal.kind,
            fact_type=proposal.fact_type,
            certainty=proposal.certainty,
            qualifier_text=proposal.qualifier_text,
            event_date=proposal.event_date,
            citations=tuple(
                CitationResponse(
                    document_id=str(citation.document_id),
                    page_number=citation.page_number,
                    quote=citation.quote,
                )
                for citation in proposal.citations
            ),
        )
        for proposal in proposals
    )


@router.post(
    "/evidence/{proposal_revision_id}/review",
    response_model=ReviewResponse,
)
def review_proposal(
    proposal_revision_id: UUID,
    payload: ReviewRequest,
    request: Request,
    service: ReviewServiceDependency,
) -> ReviewResponse | JSONResponse:
    if error := _mutation_credentials(request):
        return error
    try:
        result = service.review(
            request.cookies.get(COOKIE.name, ""),
            request.headers.get("x-csrf-token", ""),
            proposal_revision_id,
            ReviewDecision(payload.decision),
        )
    except AuthError as error:
        return _auth_error(error)
    except ReviewError as error:
        return _review_error(error)
    return ReviewResponse(
        revision_id=str(result.revision_id),
        claim_id=str(result.claim_id),
        review_state=result.review_state,
        document_status=result.document_status,
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


def _review_error(error: ReviewError) -> JSONResponse:
    status = (
        404
        if error.code
        in {ReviewErrorCode.DOCUMENT_NOT_FOUND, ReviewErrorCode.PROPOSAL_NOT_FOUND}
        else 409
    )
    return _error(status, error.code.value)


def _auth_error(error: AuthError) -> JSONResponse:
    status = 403 if error.code == AuthErrorCode.INVALID_CSRF else 401
    return _error(status, error.code.value)


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code})
