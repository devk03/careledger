import json
import math
import re
import unicodedata
from enum import StrEnum
from typing import Any

from pydantic import ValidationError

from app.ai.contracts import BoundingBox, ExtractionPayload
from app.ai.inputs import SourceBatch


class ExtractionErrorCode(StrEnum):
    RESPONSE_NOT_COMPLETED = "RESPONSE_NOT_COMPLETED"
    RESPONSE_STATE_MISMATCH = "RESPONSE_STATE_MISMATCH"
    RESPONSE_REFUSED = "RESPONSE_REFUSED"
    TOOL_OUTPUT_PRESENT = "TOOL_OUTPUT_PRESENT"
    OUTPUT_MISSING = "OUTPUT_MISSING"
    OUTPUT_AMBIGUOUS = "OUTPUT_AMBIGUOUS"
    OUTPUT_TOO_LARGE = "OUTPUT_TOO_LARGE"
    INVALID_JSON = "INVALID_JSON"
    SCHEMA_MISMATCH = "SCHEMA_MISMATCH"
    BATCH_MISMATCH = "BATCH_MISMATCH"
    DUPLICATE_REFERENCE = "DUPLICATE_REFERENCE"
    INVALID_PAGE = "INVALID_PAGE"
    INVALID_CITATION = "INVALID_CITATION"
    QUOTE_MISMATCH = "QUOTE_MISMATCH"
    INVALID_BOUNDING_BOX = "INVALID_BOUNDING_BOX"
    STRING_LIMIT = "STRING_LIMIT"


class ExtractionRejected(Exception):
    def __init__(self, code: ExtractionErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


def validate_response(
    response: object,
    batch: SourceBatch,
    *,
    max_output_bytes: int = 1_000_000,
    max_string_chars: int = 8_000,
) -> ExtractionPayload:
    if _read(response, "status") != "completed":
        raise ExtractionRejected(ExtractionErrorCode.RESPONSE_NOT_COMPLETED)
    if _read(response, "error") is not None or _read(response, "incomplete_details") is not None:
        raise ExtractionRejected(ExtractionErrorCode.RESPONSE_NOT_COMPLETED)
    if _read(response, "background") not in {None, False} or _read(response, "store") not in {
        None,
        False,
    }:
        raise ExtractionRejected(ExtractionErrorCode.RESPONSE_STATE_MISMATCH)

    output_items = _read(response, "output") or []
    text_items: list[str] = []
    for item in output_items:
        item_type = _read(item, "type")
        if item_type and ("call" in str(item_type) or "tool" in str(item_type)):
            raise ExtractionRejected(ExtractionErrorCode.TOOL_OUTPUT_PRESENT)
        for content in _read(item, "content") or []:
            content_type = _read(content, "type")
            if content_type == "refusal":
                raise ExtractionRejected(ExtractionErrorCode.RESPONSE_REFUSED)
            if content_type == "output_text":
                text = _read(content, "text")
                if isinstance(text, str):
                    text_items.append(text)

    output_text = _read(response, "output_text")
    if text_items:
        if len(text_items) != 1:
            raise ExtractionRejected(ExtractionErrorCode.OUTPUT_AMBIGUOUS)
        if output_text is not None and output_text != text_items[0]:
            raise ExtractionRejected(ExtractionErrorCode.OUTPUT_AMBIGUOUS)
        output_text = text_items[0]
    if not isinstance(output_text, str) or not output_text:
        raise ExtractionRejected(ExtractionErrorCode.OUTPUT_MISSING)
    if len(output_text.encode("utf-8")) > max_output_bytes:
        raise ExtractionRejected(ExtractionErrorCode.OUTPUT_TOO_LARGE)

    try:
        raw = json.loads(output_text, parse_constant=_reject_non_finite)
    except (json.JSONDecodeError, ValueError) as error:
        raise ExtractionRejected(ExtractionErrorCode.INVALID_JSON) from error
    _validate_string_lengths(raw, max_string_chars)
    try:
        payload = ExtractionPayload.model_validate_json(output_text, strict=True)
    except ValidationError as error:
        raise ExtractionRejected(ExtractionErrorCode.SCHEMA_MISMATCH) from error

    if payload.batch_token != batch.batch_token:
        raise ExtractionRejected(ExtractionErrorCode.BATCH_MISMATCH)
    page_context = {page.page_number: page for page in batch.pages}
    assessment_pages = [assessment.page_number for assessment in payload.page_assessments]
    if len(assessment_pages) != len(set(assessment_pages)):
        raise ExtractionRejected(ExtractionErrorCode.DUPLICATE_REFERENCE)
    if set(assessment_pages) != set(page_context):
        raise ExtractionRejected(ExtractionErrorCode.INVALID_PAGE)

    candidate_refs = [claim.candidate_ref for claim in payload.claims]
    if len(candidate_refs) != len(set(candidate_refs)) or any(
        not ref.strip() for ref in candidate_refs
    ):
        raise ExtractionRejected(ExtractionErrorCode.DUPLICATE_REFERENCE)
    for claim in payload.claims:
        if claim.event_date.iso_date is not None:
            try:
                _parse_iso_date(claim.event_date.iso_date)
            except ValueError as error:
                raise ExtractionRejected(ExtractionErrorCode.SCHEMA_MISMATCH) from error
        if not claim.citations:
            raise ExtractionRejected(ExtractionErrorCode.INVALID_CITATION)
        for citation in claim.citations:
            page = page_context.get(citation.page_number)
            if page is None:
                raise ExtractionRejected(ExtractionErrorCode.INVALID_PAGE)
            quote = citation.quote.strip() if citation.quote is not None else ""
            if not quote and citation.bbox is None:
                raise ExtractionRejected(ExtractionErrorCode.INVALID_CITATION)
            if citation.bbox is not None:
                _validate_bbox(citation.bbox)
            if quote:
                if page.text is None:
                    if citation.bbox is None:
                        raise ExtractionRejected(ExtractionErrorCode.INVALID_CITATION)
                elif _normalize(quote) not in _normalize(page.text):
                    raise ExtractionRejected(ExtractionErrorCode.QUOTE_MISMATCH)
    return payload


def _validate_bbox(box: BoundingBox) -> None:
    values = (box.x0, box.y0, box.x1, box.y1)
    if not all(math.isfinite(value) and 0 <= value <= 1 for value in values):
        raise ExtractionRejected(ExtractionErrorCode.INVALID_BOUNDING_BOX)
    if box.x0 >= box.x1 or box.y0 >= box.y1:
        raise ExtractionRejected(ExtractionErrorCode.INVALID_BOUNDING_BOX)


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip().casefold()


def _validate_string_lengths(value: Any, max_chars: int) -> None:
    if isinstance(value, str) and len(value) > max_chars:
        raise ExtractionRejected(ExtractionErrorCode.STRING_LIMIT)
    if isinstance(value, dict):
        for child in value.values():
            _validate_string_lengths(child, max_chars)
    elif isinstance(value, list):
        for child in value:
            _validate_string_lengths(child, max_chars)


def _reject_non_finite(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _parse_iso_date(value: str) -> None:
    from datetime import date

    date.fromisoformat(value)


def _read(value: object, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)
