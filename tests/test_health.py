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
