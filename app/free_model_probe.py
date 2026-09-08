"""Operator-only synthetic compatibility probe. Never reads application records or .env."""

import argparse
import getpass
import json
import sys
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from app.synthetic_probe_seed import SEED_ID, SEED_TEXT

BASE_URL = "https://openrouter.ai"
PRICE_FIELDS = ("prompt", "completion", "request", "image", "web_search", "internal_reasoning")


def is_free_model(model: dict[str, Any]) -> bool:
    identifier = model.get("id", "")
    pricing = model.get("pricing", {})
    if not isinstance(identifier, str) or not identifier.endswith(":free"):
        return False
    if not isinstance(pricing, dict) or not all(k in pricing for k in ("prompt", "completion")):
        return False
    try:
        return all(Decimal(str(pricing.get(field, "0"))) == 0 for field in PRICE_FIELDS)
    except InvalidOperation:
        return False


def build_probe_request(model: str) -> dict[str, Any]:
    if not model.endswith(":free") or any(c.isspace() for c in model):
        raise ValueError("Choose an explicit :free model; paid models and routers are disabled.")
    return {
        "model": model,
        "input": (
            "Software compatibility test with entirely fictional seeded data. "
            "Do not provide medical advice. Return the JSON object with status equal to ok.\n\n"
            + SEED_TEXT
        ),
        "store": False,
        "stream": False,
        "max_output_tokens": 128,
        "tools": [],
        "tool_choice": "none",
        "provider": {
            "zdr": True,
            "data_collection": "deny",
            "require_parameters": True,
            "allow_fallbacks": False,
            "max_price": {"prompt": 0, "completion": 0, "request": 0, "image": 0},
        },
        "plugins": [{"id": "web", "enabled": False}],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "synthetic_probe",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {"status": {"type": "string", "enum": ["ok"]}},
                    "required": ["status"],
                    "additionalProperties": False,
                },
            }
        },
    }


def valid_response(payload: object) -> bool:
    if not isinstance(payload, dict) or payload.get("status") != "completed":
        return False
    items = payload.get("output")
    if not isinstance(items, list):
        return False
    outputs = []
    for item in items:
        if not isinstance(item, dict):
            return False
        if item.get("type") != "message":
            continue
        contents = item.get("content")
        if not isinstance(contents, list):
            return False
        for content in contents:
            if not isinstance(content, dict):
                return False
            if content.get("type") == "output_text":
                if not isinstance(content.get("text"), str):
                    return False
                outputs.append(content["text"])
    try:
        return bool(json.loads("".join(outputs)) == {"status": "ok"})
    except (ValueError, TypeError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="Explicit :free model ID from --list-free")
    parser.add_argument("--list-free", action="store_true", help="Public catalog; no key needed")
    args = parser.parse_args()
    if not args.list_free and not args.model:
        parser.error("provide --list-free or --model")
    if args.model:
        request = build_probe_request(args.model)
    with httpx.Client(
        base_url=BASE_URL, timeout=45, follow_redirects=False, trust_env=False
    ) as client:
        catalog = client.get("/api/v1/models")
        catalog.raise_for_status()
        eligible = [m for m in catalog.json()["data"] if is_free_model(m)]
        if args.list_free:
            for model in eligible:
                print(model["id"])
            return 0
        if args.model not in {m["id"] for m in eligible}:
            print("Refused: model is not currently listed with zero prices. No inference sent.")
            return 1
        if not sys.stdin.isatty():
            print("Use an interactive terminal for the hidden key prompt; no inference sent.")
            return 1
        print(f"Sending only built-in fictional seed: {SEED_ID}. No uploaded records are read.")
        key = getpass.getpass("OpenRouter test key (hidden, not saved): ").strip()
        if not key:
            print("No key supplied. No inference sent.")
            return 1
        response = client.post(
            "/api/v1/responses",
            headers={"Authorization": f"Bearer {key}", "X-OpenRouter-Cache": "false"},
            json=request,
        )
        if response.status_code != 200:
            print(f"Probe rejected (HTTP {response.status_code}); no retry or paid fallback.")
            return 1
        passed = valid_response(response.json())
        print("Synthetic structured-text probe: " + ("PASS" if passed else "FAIL"))
        print("This does not verify PDF/image extraction, medical quality, or hosted readiness.")
        print("Verify the request's actual charge in your OpenRouter activity dashboard.")
        return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        # Do not expose provider response bodies, credentials, or request headers.
        print(
            "Probe failed safely. No automatic retry; check connectivity and provider availability."
        )
        raise SystemExit(1) from None
