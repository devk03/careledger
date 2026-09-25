import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.project import router
from app.config import Settings


def test_runtime_mode_is_staging_only(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI()
    app.include_router(router)
    monkeypatch.setattr("app.api.project.get_settings", lambda: Settings(app_environment="staging"))
    assert TestClient(app).get("/api/public/runtime").json() == {
        "restricted_preview": True
    }
    monkeypatch.setattr(
        "app.api.project.get_settings", lambda: Settings(app_environment="production")
    )
    assert TestClient(app).get("/api/public/runtime").json() == {
        "restricted_preview": False
    }
