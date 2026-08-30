import os
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app.security.bootstrap import BootstrapManager


def test_bootstrap_token_is_created_once_and_reused_across_restart(tmp_path: Path) -> None:
    manager = BootstrapManager(tmp_path, "http://localhost:8080")

    first = manager.initialize()
    second = manager.initialize()

    assert first.setup_required is True
    assert first.token_created is True
    assert first.setup_url is not None
    token = parse_qs(urlparse(first.setup_url).fragment)["token"][0]
    assert token not in (tmp_path / "bootstrap-token.sha256").read_text(encoding="utf-8")
    assert (tmp_path / "bootstrap-token").read_text(encoding="utf-8") == token
    assert (tmp_path / "bootstrap-token").stat().st_mode & 0o777 == 0o600
    assert manager.verify(token) is True
    assert second.setup_required is True
    assert second.token_created is False
    assert second.setup_url == first.setup_url


def test_bootstrap_recovers_when_legacy_hash_has_no_token(tmp_path: Path) -> None:
    (tmp_path / "bootstrap-token.sha256").write_text("0" * 64, encoding="utf-8")
    manager = BootstrapManager(tmp_path, "http://localhost:8080")

    state = manager.initialize()

    assert state.token_created is True
    assert state.setup_url is not None
    token = parse_qs(urlparse(state.setup_url).fragment)["token"][0]
    assert manager.verify(token) is True


def test_expired_bootstrap_token_rotates_without_sleeping(tmp_path: Path) -> None:
    manager = BootstrapManager(tmp_path, "http://localhost:8080", token_ttl_seconds=60)
    first = manager.initialize()
    assert first.setup_url is not None
    first_token = parse_qs(urlparse(first.setup_url).fragment)["token"][0]
    expired_time = time.time() - 61
    os.utime(tmp_path / "bootstrap-token", (expired_time, expired_time))

    second = manager.initialize()

    assert second.setup_url is not None
    second_token = parse_qs(urlparse(second.setup_url).fragment)["token"][0]
    assert second.token_created is True
    assert second_token != first_token
    assert manager.verify(first_token) is False
    assert manager.verify(second_token) is True


def test_bootstrap_completion_is_single_use(tmp_path: Path) -> None:
    manager = BootstrapManager(tmp_path, "http://localhost:8080")
    state = manager.initialize()
    assert state.setup_url is not None
    token = parse_qs(urlparse(state.setup_url).fragment)["token"][0]

    assert manager.complete(token) is True
    assert manager.verify(token) is False
    assert manager.complete(token) is False
    assert manager.initialize().setup_required is False
