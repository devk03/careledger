import hashlib
import json
from collections.abc import Mapping
from typing import Any

from app.ai.contracts import ExtractionPayload

SCHEMA_NAME = "careledger_record_extraction_v1"


def extraction_json_schema() -> dict[str, Any]:
    return ExtractionPayload.model_json_schema()


def strict_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "name": SCHEMA_NAME,
        "strict": True,
        "schema": extraction_json_schema(),
    }


def canonical_json(value: Mapping[str, Any] | list[Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def schema_sha256() -> str:
    return hashlib.sha256(canonical_json(strict_format()).encode("utf-8")).hexdigest()


def assert_strict_schema(schema: Mapping[str, Any]) -> None:
    unsupported = {"minLength", "maxLength", "pattern", "minimum", "maximum"}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                properties = node.get("properties", {})
                if node.get("additionalProperties") is not False:
                    raise ValueError("every object must forbid additional properties")
                if set(node.get("required", [])) != set(properties):
                    raise ValueError("every object property must be required")
            if unsupported.intersection(node):
                raise ValueError("schema contains unsupported constrained-output keywords")
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    if schema.get("type") != "object":
        raise ValueError("the root extraction schema must be an object")
    walk(schema)
