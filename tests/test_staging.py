from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


def test_preview_gate_blocks_pages_and_apis_but_allows_health(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APP_ENVIRONMENT", "staging")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://preview.example.test")
    monkeypatch.setenv("STAGING_ACCESS_PASSWORD", "synthetic-preview-password-32-characters")
    monkeypatch.setenv("AI_PROVIDER", "disabled")
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as client:
            for path in ("/", "/setup", "/api/system/setup-status", "/openapi.json"):
                response = client.get(path)
                assert response.status_code == 401
                assert response.headers["cache-control"] == "no-store"
            assert client.get("/health/ready").status_code == 200
            assert client.post("/health/ready").status_code == 401
            for header in ("Bearer bad", "Basic !!!", "Basic YWRlbm86YmFk"):
                assert client.get("/setup", headers={"Authorization": header}).status_code == 401
            authorized = client.get(
                "/api/system/setup-status",
                auth=("adeno", "synthetic-preview-password-32-characters"),
            )
            assert authorized.status_code == 200
            assert authorized.json()["ai_available"] is False
            assert "staging_access_password" not in authorized.text
        token = (tmp_path / "secrets" / "bootstrap-token").read_text().strip()
        assert token not in caplog.text
        assert "#token=" not in caplog.text
    finally:
        get_settings.cache_clear()


def test_staging_missing_gate_fails_before_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENVIRONMENT", "staging")
    monkeypatch.delenv("STAGING_ACCESS_PASSWORD", raising=False)
    get_settings.cache_clear()
    try:
        with pytest.raises(ValueError, match="access password"):
            create_app()
    finally:
        get_settings.cache_clear()
