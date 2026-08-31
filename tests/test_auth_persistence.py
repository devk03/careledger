from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.security.auth import AuthError, AuthErrorCode, AuthService
from app.security.bootstrap import BootstrapManager
from app.security.passwords import PasswordManager
from app.storage.database import Database


def _service(tmp_path: Path) -> tuple[AuthService, BootstrapManager, Database, str]:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    bootstrap = BootstrapManager(tmp_path / "secrets", "http://localhost:8080")
    state = bootstrap.initialize(setup_complete=False)
    assert state.setup_url is not None
    token = parse_qs(urlparse(state.setup_url).fragment)["token"][0]
    service = AuthService(
        database,
        bootstrap,
        b"r" * 32,
        passwords=PasswordManager(time_cost=1, memory_cost=8_192, parallelism=1),
    )
    return service, bootstrap, database, token


def test_owner_setup_login_session_and_logout_are_persistent(tmp_path: Path) -> None:
    service, _, database, token = _service(tmp_path)
    password = "synthetic owner passphrase"  # noqa: S105 - synthetic test value

    setup = service.setup_owner(
        token,
        password,
        display_name="Synthetic organizer",
        household_name="Synthetic household",
        now=1_800_000_000,
    )

    assert database.is_setup_complete() is True
    assert service.session(setup.plaintext_token, now=1_800_000_001).user == setup.user
    with pytest.raises(AuthError) as reused:
        service.setup_owner(
            token,
            password,
            display_name="Second organizer",
            household_name="Second household",
            now=1_800_000_002,
        )
    assert reused.value.code == AuthErrorCode.SETUP_ALREADY_COMPLETE

    with pytest.raises(AuthError) as bad_login:
        service.login("wrong synthetic passphrase", now=1_800_000_003)
    assert bad_login.value.code == AuthErrorCode.INVALID_CREDENTIALS

    login = service.login(password, now=1_800_000_004)
    record = service.session(login.plaintext_token, now=1_800_000_005)
    with pytest.raises(AuthError) as bad_csrf:
        service.logout(login.plaintext_token, "wrong", now=1_800_000_006)
    assert bad_csrf.value.code == AuthErrorCode.INVALID_CSRF

    service.logout(login.plaintext_token, service.issue_csrf(record), now=1_800_000_007)
    with pytest.raises(AuthError) as logged_out:
        service.session(login.plaintext_token, now=1_800_000_008)
    assert logged_out.value.code == AuthErrorCode.INVALID_SESSION

    database_bytes = (tmp_path / "app.sqlite").read_bytes()
    wal_path = tmp_path / "app.sqlite-wal"
    combined = database_bytes + (wal_path.read_bytes() if wal_path.exists() else b"")
    assert password.encode() not in combined
    assert setup.plaintext_token.encode() not in combined
    assert all(code.encode() not in combined for code in setup.recovery_codes)


def test_recovery_rotates_password_codes_and_every_prior_session(tmp_path: Path) -> None:
    service, _, _, token = _service(tmp_path)
    setup = service.setup_owner(
        token,
        "synthetic original passphrase",
        display_name="Synthetic organizer",
        household_name="Synthetic household",
        now=1_800_000_000,
    )
    prior_login = service.login("synthetic original passphrase", now=1_800_000_001)

    recovered = service.recover(
        setup.recovery_codes[0],
        "synthetic replacement passphrase",
        now=1_800_000_002,
    )

    assert len(recovered.recovery_codes) == 10
    assert set(recovered.recovery_codes).isdisjoint(set(setup.recovery_codes))
    for old_token in (setup.plaintext_token, prior_login.plaintext_token):
        with pytest.raises(AuthError) as old_session:
            service.session(old_token, now=1_800_000_003)
        assert old_session.value.code == AuthErrorCode.INVALID_SESSION
    with pytest.raises(AuthError) as old_password:
        service.login("synthetic original passphrase", now=1_800_000_004)
    assert old_password.value.code == AuthErrorCode.INVALID_CREDENTIALS
    replacement_login = service.login(
        "synthetic replacement passphrase",
        now=1_800_000_005,
    )
    assert replacement_login.user == recovered.user
    with pytest.raises(AuthError) as used_code:
        service.recover(
            setup.recovery_codes[0],
            "another synthetic passphrase",
            now=1_800_000_006,
        )
    assert used_code.value.code == AuthErrorCode.INVALID_CREDENTIALS


def test_setup_and_session_http_contract(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://localhost:8080")
    get_settings.cache_clear()

    with TestClient(create_app(), base_url="https://localhost:8080") as client:
        token = (tmp_path / "secrets" / "bootstrap-token").read_text(encoding="utf-8")
        rejected = client.post(
            "/api/auth/setup",
            headers={"Origin": "https://not-careledger.invalid"},
            json={
                "token": token,
                "password": "synthetic owner passphrase",
                "display_name": "Synthetic organizer",
                "household_name": "Synthetic household",
            },
        )
        assert rejected.status_code == 403

        setup = client.post(
            "/api/auth/setup",
            headers={"Origin": "https://localhost:8080", "Sec-Fetch-Site": "same-origin"},
            json={
                "token": token,
                "password": "synthetic owner passphrase",
                "display_name": "Synthetic organizer",
                "household_name": "Synthetic household",
            },
        )
        assert setup.status_code == 201
        assert setup.json()["authenticated"] is True
        setup_codes = setup.json()["recovery_codes"]
        assert len(setup_codes) == 10
        cookie = setup.headers["set-cookie"]
        assert "__Host-careledger_session=" in cookie
        assert "HttpOnly" in cookie
        assert "Max-Age=28800" in cookie
        assert "Path=/" in cookie
        assert "SameSite=strict" in cookie
        assert "Secure" in cookie
        assert "Domain=" not in cookie

        status = client.get("/api/system/setup-status")
        assert status.json()["setup_required"] is False
        current = client.get("/api/auth/session")
        assert current.json()["authenticated"] is True
        csrf = current.json()["csrf_token"]

        missing_csrf = client.post(
            "/api/auth/logout",
            headers={"Origin": "https://localhost:8080", "Sec-Fetch-Site": "same-origin"},
        )
        assert missing_csrf.status_code == 403
        logout = client.post(
            "/api/auth/logout",
            headers={
                "Origin": "https://localhost:8080",
                "Sec-Fetch-Site": "same-origin",
                "X-CSRF-Token": csrf,
            },
        )
        assert logout.status_code == 204
        assert client.get("/api/auth/session").json() == {
            "authenticated": False,
            "user": None,
            "csrf_token": None,
            "expires_at": None,
            "recovery_codes": [],
        }

        recovered = client.post(
            "/api/auth/recover",
            headers={"Origin": "https://localhost:8080", "Sec-Fetch-Site": "same-origin"},
            json={
                "recovery_code": setup_codes[0],
                "new_password": "synthetic replacement passphrase",
            },
        )
        assert recovered.status_code == 200
        assert recovered.json()["authenticated"] is True
        assert len(recovered.json()["recovery_codes"]) == 10

    get_settings.cache_clear()
