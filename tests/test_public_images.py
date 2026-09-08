from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.mark.parametrize("with_images", [True, False])
def test_spa_and_image_routes_without_starting_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    with_images: bool,
) -> None:
    web = tmp_path / "web"
    web.mkdir()
    (web / "assets").mkdir()
    (web / "index.html").write_text("<html>synthetic test app</html>")
    if with_images:
        (web / "images").mkdir()
        (web / "images" / "test.webp").write_bytes(b"synthetic-image-routing-fixture")
    monkeypatch.setattr(Settings, "web_dist_dir", property(lambda self: web))
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setattr("app.main.get_settings", lambda: Settings(ai_provider="disabled"))
    # No TestClient context manager: lifespan and DB initialization are not invoked.
    client = TestClient(create_app())
    assert client.get("/setup").text == "<html>synthetic test app</html>"
    if with_images:
        response = client.get("/images/test.webp")
        assert response.headers["content-type"] == "image/webp"
        assert response.content == b"synthetic-image-routing-fixture"
