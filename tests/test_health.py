from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


def test_health_endpoints_disclose_only_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()

    with TestClient(create_app()) as client:
        live = client.get("/health/live")
        ready = client.get("/health/ready")

    assert live.status_code == 200
    assert live.json() == {"status": "ok"}
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready"}
    assert ready.headers["cache-control"] == "no-store"
    assert ready.headers["x-content-type-options"] == "nosniff"
    assert ready.headers["x-frame-options"] == "DENY"
    assert ready.headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in ready.headers["content-security-policy"]
    get_settings.cache_clear()


def test_managed_mode_csp_allows_only_careledger_and_openrouter_connections(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AI_CREDENTIAL_MODE", "per_user_oauth")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_AI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_AI_BASE_URL", raising=False)
    get_settings.cache_clear()

    with TestClient(create_app()) as client:
        response = client.get("/health/ready")
        callback = client.get("/openrouter/callback/" + "a" * 43 + "?code=synthetic")

    policy = response.headers["content-security-policy"]
    assert "connect-src 'self' https://openrouter.ai" in policy
    assert "https://" not in policy.replace("https://openrouter.ai", "")
    assert callback.headers["cache-control"] == "no-store"
    assert callback.headers["referrer-policy"] == "no-referrer"
    get_settings.cache_clear()


def test_incomplete_managed_edition_fails_before_plaintext_routes_are_mounted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_EDITION", "managed")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="ciphertext-only routes"):
        create_app()
    get_settings.cache_clear()
