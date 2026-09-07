import base64
import hashlib
import hmac
import json
import re
from enum import StrEnum
from typing import Any

from app.ai.inputs import SourceBatch
from app.ai.prompts import EXTRACTION_INSTRUCTIONS
from app.ai.schema import strict_format
from app.ingest.models import MediaType

_OPAQUE_IDENTIFIER = re.compile(r"^[0-9a-f]{64}$")


class InferenceBoundary(StrEnum):
    DIRECT = "direct"
    OPENROUTER_PATIENT_DATA = "openrouter_patient_data"


def opaque_safety_identifier(actor_id: str, secret: bytes) -> str:
    if not actor_id or len(secret) < 32:
        raise ValueError("actor ID and a 32-byte local secret are required")
    return hmac.new(secret, actor_id.encode("utf-8"), hashlib.sha256).hexdigest()


def build_extraction_request(
    batch: SourceBatch,
    *,
    model: str,
    safety_identifier: str,
    boundary: InferenceBoundary,
    max_output_tokens: int = 12_000,
) -> dict[str, Any]:
    if not _OPAQUE_IDENTIFIER.fullmatch(safety_identifier):
        raise ValueError("safety identifier must be an opaque lowercase SHA-256 value")
    manifest = json.dumps(
        {
            "batch_token": batch.batch_token,
            "original_page_numbers": [page.page_number for page in batch.pages],
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": f"Trusted page mapping: {manifest}",
        }
    ]
    encoded = base64.b64encode(batch.transmitted_bytes).decode("ascii")
    if batch.media_type == MediaType.PDF:
        content.append(
            {
                "type": "input_file",
                "filename": f"source-{batch.source_sha256[:12]}.pdf",
                "file_data": f"data:{batch.media_type.value};base64,{encoded}",
            }
        )
    else:
        content.append(
            {
                "type": "input_image",
                "detail": "high",
                "image_url": f"data:{batch.media_type.value};base64,{encoded}",
            }
        )

    request: dict[str, Any] = {
        "model": model,
        "store": False,
        "background": False,
        "stream": False,
        "tools": [],
        "tool_choice": "none",
        "parallel_tool_calls": False,
        "truncation": "disabled",
        "instructions": EXTRACTION_INSTRUCTIONS,
        "safety_identifier": safety_identifier,
        "max_output_tokens": max_output_tokens,
        "input": [{"role": "user", "content": content}],
        "text": {"format": strict_format()},
    }
    if boundary == InferenceBoundary.OPENROUTER_PATIENT_DATA:
        if ":online" in model.casefold():
            raise ValueError("patient-data models cannot enable online search")
        request["extra_body"] = {
            "provider": {
                "zdr": True,
                "data_collection": "deny",
                "require_parameters": True,
                "allow_fallbacks": False,
            },
            "plugins": [{"id": "web", "enabled": False}],
        }
        request["extra_headers"] = {"X-OpenRouter-Cache": "false"}
    return request


def assert_openrouter_patient_request(request: dict[str, Any]) -> None:
    required_body = {
        "provider": {
            "zdr": True,
            "data_collection": "deny",
            "require_parameters": True,
            "allow_fallbacks": False,
        },
        "plugins": [{"id": "web", "enabled": False}],
    }
    if (
        request.get("extra_body") != required_body
        or request.get("extra_headers") != {"X-OpenRouter-Cache": "false"}
        or request.get("store") is not False
        or request.get("background") is not False
        or request.get("tools") != []
        or request.get("tool_choice") != "none"
        or request.get("parallel_tool_calls") is not False
    ):
        raise ValueError("OpenRouter patient-data policy is incomplete")
    model = request.get("model")
    if not isinstance(model, str) or ":online" in model.casefold():
        raise ValueError("OpenRouter patient-data model is unsafe")
