from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.security.passwords import PasswordErrorCode, PasswordManager, PasswordPolicyError
from app.security.throttle import LoginBackoffPolicy
from app.security.tokens import (
    SessionCookiePolicy,
    generate_recovery_codes,
    hash_session_token,
    issue_csrf_token,
    issue_session_token,
    verify_csrf_token,
    verify_recovery_code,
)


def test_passwords_use_argon2id_and_fail_closed() -> None:
    manager = PasswordManager(time_cost=1, memory_cost=8_192, parallelism=1)
    encoded = manager.hash("synthetic passphrase only")

    assert encoded.startswith("$argon2id$")
    assert manager.verify(encoded, "synthetic passphrase only") is True
    assert manager.verify(encoded, "wrong synthetic passphrase") is False
    assert manager.verify("not-a-password-hash", "synthetic passphrase only") is False


def test_password_policy_is_length_based_without_forced_complexity() -> None:
    with pytest.raises(PasswordPolicyError) as too_short:
        PasswordManager().hash("short")
    assert too_short.value.code == PasswordErrorCode.TOO_SHORT

    assert PasswordManager(time_cost=1, memory_cost=8_192, parallelism=1).hash(
        "a calm multi word passphrase"
    ).startswith("$argon2id$")


def test_session_tokens_are_stored_only_as_hashes() -> None:
    issued = issue_session_token()
    assert issued.plaintext not in issued.sha256
    assert hash_session_token(issued.plaintext) == issued.sha256
    assert SessionCookiePolicy().name.startswith("__Host-")
    assert SessionCookiePolicy().secure is True
    assert SessionCookiePolicy().same_site == "strict"


def test_recovery_codes_are_high_entropy_hmac_values() -> None:
    pepper = b"r" * 32
    codes = generate_recovery_codes(pepper, count=4)

    assert len(set(codes.plaintext_codes)) == 4
    assert all(
        code not in digest
        for code, digest in zip(codes.plaintext_codes, codes.hmac_sha256, strict=True)
    )
    assert verify_recovery_code(codes.plaintext_codes[0], codes.hmac_sha256[0], pepper)
    assert not verify_recovery_code("WRONG-CODE", codes.hmac_sha256[0], pepper)


def test_csrf_token_is_bound_to_session_and_secret() -> None:
    session_id = uuid4()
    secret = b"c" * 32
    token = issue_csrf_token(session_id, secret)

    assert verify_csrf_token(token, session_id, secret)
    assert not verify_csrf_token(token, uuid4(), secret)
    assert not verify_csrf_token(token, session_id, b"d" * 32)


def test_login_backoff_is_bounded_and_deterministic() -> None:
    policy = LoginBackoffPolicy()
    now = datetime(2026, 1, 1, tzinfo=UTC)

    assert policy.delay_seconds(4) == 0
    assert policy.delay_seconds(5) == 2
    assert policy.delay_seconds(6) == 4
    assert policy.delay_seconds(100) == 15 * 60
    assert (policy.locked_until(5, now=now) - now).total_seconds() == 2
