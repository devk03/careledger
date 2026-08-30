import hashlib
import importlib.metadata
from dataclasses import dataclass
from typing import Any

from app.ai.contracts import ExtractionPayload
from app.ai.inputs import SourceBatch
from app.ai.prompts import PROMPT_VERSION, prompt_sha256
from app.ai.request import build_extraction_request
from app.ai.schema import canonical_json, schema_sha256
from app.ai.transport import ResponsesTransport
from app.ai.validators import validate_response


@dataclass(frozen=True)
class RunProvenance:
    contract_version: str
    prompt_version: str
    prompt_sha256: str
    schema_sha256: str
    request_sha256: str
    requested_model: str
    response_model: str
    openai_sdk_version: str
    source_sha256: str
    transmitted_sha256: str
    page_artifact_sha256: tuple[str, ...]
    batch_token: str
    response_id: str
    response_created_at: int | None
    usage: dict[str, int]
    review_state: str = "proposed"


@dataclass(frozen=True)
class ValidatedExtraction:
    provenance: RunProvenance
    payload: ExtractionPayload


class ExtractionService:
    def __init__(self, transport: ResponsesTransport, *, model: str) -> None:
        self._transport = transport
        self._model = model

    def extract(self, batch: SourceBatch, *, safety_identifier: str) -> ValidatedExtraction:
        request = build_extraction_request(
            batch,
            model=self._model,
            safety_identifier=safety_identifier,
        )
        response = self._transport.create(request)
        payload = validate_response(response, batch)
        provenance = RunProvenance(
            contract_version=payload.contract_version,
            prompt_version=PROMPT_VERSION,
            prompt_sha256=prompt_sha256(),
            schema_sha256=schema_sha256(),
            request_sha256=hashlib.sha256(canonical_json(request).encode("utf-8")).hexdigest(),
            requested_model=self._model,
            response_model=str(_read(response, "model") or "unknown"),
            openai_sdk_version=importlib.metadata.version("openai"),
            source_sha256=batch.source_sha256,
            transmitted_sha256=batch.transmitted_sha256,
            page_artifact_sha256=tuple(page.artifact_sha256 for page in batch.pages),
            batch_token=batch.batch_token,
            response_id=str(_read(response, "id") or "unknown"),
            response_created_at=_integer_or_none(_read(response, "created_at")),
            usage=_safe_usage(_read(response, "usage")),
        )
        return ValidatedExtraction(provenance=provenance, payload=payload)


def _safe_usage(value: object) -> dict[str, int]:
    allowed = ("input_tokens", "output_tokens", "total_tokens")
    result: dict[str, int] = {}
    for key in allowed:
        count = _read(value, key)
        if isinstance(count, int) and count >= 0:
            result[key] = count
    return result


def _read(value: object, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _integer_or_none(value: object) -> int | None:
    return value if isinstance(value, int) else None
