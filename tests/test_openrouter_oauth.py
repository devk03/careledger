import base64
import hashlib
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import pytest

from app.ai.openrouter_oauth import (
    consume_pending_flow,
    create_pkce_authorization,
    exchange_payload,
    normalize_authorization_code,
    parse_issued_key,
    pending_flow,
)


def _synthetic_random(length: int) -> bytes:
    return bytes(index % 251 for index in range(length))


def test_pkce_authorization_is_s256_and_callback_is_flow_specific() -> None:
    with patch("app.ai.openrouter_oauth.os.urandom", side_effect=_synthetic_random):
        authorization = create_pkce_authorization("https://care.example.test")

    parsed = urlsplit(authorization.authorization_url)
    query = parse_qs(parsed.query)
    expected = base64.urlsafe_b64encode(
        hashlib.sha256(authorization.code_verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    assert parsed.scheme == "https"
    assert parsed.netloc == "openrouter.ai"
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] == [expected]
    assert query["callback_url"] == [authorization.callback_url]
    assert authorization.flow_token in authorization.callback_url
    assert "code_verifier" not in authorization.authorization_url


def test_pkce_allows_local_http_but_rejects_public_http_and_paths() -> None:
    assert create_pkce_authorization("http://localhost:8080").callback_url.startswith(
        "http://localhost:8080/"
    )
    with pytest.raises(ValueError, match="HTTPS"):
        create_pkce_authorization("http://care.example.test")
    with pytest.raises(ValueError, match="origin"):
        create_pkce_authorization("https://care.example.test/prefix")


def test_exchange_payload_is_bounded_and_never_contains_a_challenge() -> None:
    with patch("app.ai.openrouter_oauth.os.urandom", side_effect=_synthetic_random):
        authorization = create_pkce_authorization("https://care.example.test")
    payload = exchange_payload("synthetic-code_123", authorization.code_verifier)
    assert payload == {
        "code": "synthetic-code_123",
        "code_verifier": authorization.code_verifier,
        "code_challenge_method": "S256",
    }
    assert "code_challenge" not in payload
    with pytest.raises(ValueError, match="invalid shape"):
        normalize_authorization_code("code with spaces")


def test_issued_key_parser_accepts_only_user_credentials() -> None:
    issued = parse_issued_key(
        {
            "key": "sk-or-v1-synthetic-credential-value",
            "user_id": "synthetic-user",
        }
    )
    assert issued.provider_user_id == "synthetic-user"
    with pytest.raises(ValueError, match="invalid credential"):
        parse_issued_key({"key": "not-an-openrouter-key"})
    with pytest.raises(ValueError, match="user identifier"):
        parse_issued_key(
            {"key": "sk-or-v1-synthetic-credential-value", "user_id": "bad\nuser"}
        )


def test_secret_oauth_values_are_absent_from_representations() -> None:
    authorization = create_pkce_authorization("https://care.example.test")
    issued = parse_issued_key({"key": "sk-or-v1-synthetic-credential-value"})
    assert authorization.code_verifier not in repr(authorization)
    assert authorization.flow_token not in repr(authorization)
    assert issued.plaintext_key not in repr(issued)


def test_pending_flow_is_ten_minute_single_use_and_bound_to_session_scope() -> None:
    authorization = create_pkce_authorization("https://care.example.test")
    flow = pending_flow(
        authorization,
        household_id="synthetic-household",
        user_id="synthetic-user",
        session_id="synthetic-session",
        created_at=1_000,
    )
    consumed = consume_pending_flow(
        flow,
        flow_token=authorization.flow_token,
        household_id="synthetic-household",
        user_id="synthetic-user",
        session_id="synthetic-session",
        now=1_001,
    )
    with pytest.raises(ValueError, match="invalid or expired"):
        consume_pending_flow(
            consumed,
            flow_token=authorization.flow_token,
            household_id="synthetic-household",
            user_id="synthetic-user",
            session_id="synthetic-session",
            now=1_002,
        )
    with pytest.raises(ValueError, match="invalid or expired"):
        consume_pending_flow(
            flow,
            flow_token=authorization.flow_token,
            household_id="synthetic-household",
            user_id="different-user",
            session_id="synthetic-session",
            now=1_001,
        )
    with pytest.raises(ValueError, match="invalid or expired"):
        consume_pending_flow(
            flow,
            flow_token=authorization.flow_token,
            household_id="synthetic-household",
            user_id="synthetic-user",
            session_id="synthetic-session",
            now=1_600,
        )
