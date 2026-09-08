import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import project


@pytest.mark.parametrize("count", [0, 42, -1, True, "42", None])
def test_public_stars_validate_and_cache(monkeypatch: pytest.MonkeyPatch, count: object) -> None:
    calls = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert str(request.url) == project.API_URL
        assert "authorization" not in request.headers
        assert "cookie" not in request.headers
        return httpx.Response(200, json={"stargazers_count": count})

    original = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kw: original(
            **kw,
            transport=httpx.MockTransport(handle),
        ),
    )
    cache = project.StarCache()
    value = cache.get()
    assert value.stars == (count if type(count) is int and count >= 0 else None)
    cache.get()
    assert len(calls) == 1


def test_failure_retains_last_count_and_backs_off(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(429)

    original = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kw: original(
            **kw,
            transport=httpx.MockTransport(handle),
        ),
    )
    cache = project.StarCache()
    cache.value = project.ProjectStats(stars=7, checked_at=123)
    assert cache.get() == project.ProjectStats(stars=7, checked_at=123, stale=True)
    cache.get()
    assert len(calls) == 1


def test_endpoint_needs_no_database_or_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(project.star_cache, "get", lambda: project.ProjectStats(stars=0))
    app = FastAPI()
    app.include_router(project.router)
    response = TestClient(app).get("/api/public/project?repo=ignored")
    assert response.status_code == 200
    assert response.json() == {"stars": 0, "checked_at": None, "stale": False}
