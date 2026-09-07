from dataclasses import replace
from unittest.mock import patch

import pytest

from app.security.credential_vault import (
    CredentialDecryptionError,
    CredentialScope,
    CredentialVault,
    credential_fingerprint,
)

SYNTHETIC_KEY = "sk-or-v1-synthetic-only-never-a-real-key"
SCOPE = CredentialScope(
    environment="test",
    household_id="synthetic-household",
    user_id="synthetic-user",
    credential_id="synthetic-credential",
    provider="openrouter",
)


def test_credential_vault_round_trip_binds_every_scope_dimension() -> None:
    vault = CredentialVault(b"v" * 32)
    with patch("app.security.credential_vault.os.urandom", return_value=b"n" * 12):
        encrypted = vault.encrypt(SYNTHETIC_KEY, SCOPE)

    assert SYNTHETIC_KEY.encode() not in encrypted.ciphertext
    assert vault.decrypt(encrypted, SCOPE) == SYNTHETIC_KEY
    for field in ("environment", "household_id", "user_id", "credential_id", "provider"):
        with pytest.raises(CredentialDecryptionError, match="unavailable"):
            vault.decrypt(encrypted, replace(SCOPE, **{field: f"different-{field}"}))


def test_credential_vault_rejects_wrong_key_version_and_tampering_without_secret_details() -> None:
    encrypted = CredentialVault(b"v" * 32).encrypt(SYNTHETIC_KEY, SCOPE)
    with pytest.raises(CredentialDecryptionError) as wrong_version:
        CredentialVault(b"v" * 32, key_version=2).decrypt(encrypted, SCOPE)
    assert SYNTHETIC_KEY not in str(wrong_version.value)

    tampered = replace(encrypted, ciphertext=encrypted.ciphertext[:-1] + b"x")
    with pytest.raises(CredentialDecryptionError) as rejected:
        CredentialVault(b"v" * 32).decrypt(tampered, SCOPE)
    assert SYNTHETIC_KEY not in str(rejected.value)


def test_credential_fingerprint_is_stable_and_not_the_plaintext() -> None:
    fingerprint = credential_fingerprint(SYNTHETIC_KEY)
    assert len(fingerprint) == 64
    assert fingerprint != SYNTHETIC_KEY


def test_credential_encryption_generates_unique_nonces() -> None:
    vault = CredentialVault(b"v" * 32)
    first = vault.encrypt(SYNTHETIC_KEY, SCOPE)
    second = vault.encrypt(SYNTHETIC_KEY, SCOPE)
    assert first.nonce != second.nonce
    assert first.ciphertext != second.ciphertext
