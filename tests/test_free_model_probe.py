from typing import Any

import httpx
import pytest

from app.free_model_probe import build_probe_request, is_free_model, valid_response
from app.synthetic_probe_seed import SEED_TEXT


def test_catalog_requires_free_variant_and_zero_prices() -> None:
    assert is_free_model({"id": "example/test:free", "pricing": {"prompt": "0", "completion": "0"}})
    for model in (
        {"id": "example/paid", "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "example/test:free", "pricing": {"prompt": "0", "completion": "0.1"}},
        {"id": "example/test:free", "pricing": {"prompt": "0", "completion": "0", "request": "1"}},
        {"id": "example/test:free", "pricing": {}},
    ):
        assert not is_free_model(model)


@pytest.mark.parametrize(
    "model", ["openai/gpt-5.4-mini", "openrouter/free", "a:free:online", " a:free"]
)
def test_probe_rejects_paid_or_dynamic_routing(model: str) -> None:
    with pytest.raises(ValueError):
        build_probe_request(model)


def test_probe_is_fixed_and_privacy_constrained() -> None:
    request = build_probe_request("example/test:free")
    assert request["provider"]["max_price"] == {
        "prompt": 0,
        "completion": 0,
        "request": 0,
        "image": 0,
    }
    assert request["provider"]["allow_fallbacks"] is False
    assert request["provider"]["zdr"] is True
    assert request["provider"]["data_collection"] == "deny"
    assert request["store"] is False
    assert request["tools"] == []
    assert request["max_output_tokens"] == 128


def test_response_requires_completed_exact_json() -> None:
    payload = {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [
                    {"type": "output_text", "text": '{"status":"ok"}'},
                ],
            }
        ],
    }
    assert valid_response(payload)
    assert not valid_response({"status": "incomplete", "output": payload["output"]})
    assert not valid_response({"status": "completed", "output": []})


def test_seeded_request_never_reads_files_or_database(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("Probe must not read records, files, or a database")

    monkeypatch.setattr("builtins.open", forbidden)
    monkeypatch.setattr("pathlib.Path.open", forbidden)
    monkeypatch.setattr("sqlite3.connect", forbidden)
    monkeypatch.setenv("DATA_DIR", "/nonexistent/private-records-canary")
    request = build_probe_request("example/test:free")
    assert request["input"].endswith(SEED_TEXT)
    assert "SYNTHETIC TEST RECORD — NOT A REAL PATIENT" in request["input"]
    assert "private-records-canary" not in str(request)


@pytest.mark.parametrize("option", ["--file", "--prompt", "--data-dir", "--url"])
def test_cli_rejects_arbitrary_data_sources(monkeypatch: pytest.MonkeyPatch, option: str) -> None:
    from app.free_model_probe import main

    monkeypatch.setattr("sys.argv", ["probe", option, "private-source-canary"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"status": "completed", "output": None},
        {"status": "completed", "output": [None]},
        {"status": "completed", "output": [{"type": "message", "content": [None]}]},
    ],
)
def test_malformed_response_fails_closed(payload: object) -> None:
    assert not valid_response(payload)


def test_probe_disables_environment_proxy_and_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.free_model_probe import main

    original = httpx.Client

    def client(**kwargs: Any) -> httpx.Client:
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        return original(
            **kwargs,
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": []})),
        )

    monkeypatch.setattr(httpx, "Client", client)
    monkeypatch.setattr("sys.argv", ["probe", "--list-free"])
    assert main() == 0
