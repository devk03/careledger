import hashlib
import json
import os
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class CredentialDecryptionError(Exception):
    pass


@dataclass(frozen=True)
class CredentialScope:
    environment: str
    household_id: str
    user_id: str
    credential_id: str
    provider: str

    def associated_data(self) -> bytes:
        values = {
            "credential_id": self.credential_id,
            "environment": self.environment,
            "household_id": self.household_id,
            "provider": self.provider,
            "user_id": self.user_id,
        }
        if any(not value or len(value) > 256 for value in values.values()):
            raise ValueError("credential scope values must be present and bounded")
        return json.dumps(values, separators=(",", ":"), sort_keys=True).encode("utf-8")


@dataclass(frozen=True)
class EncryptedCredential:
    ciphertext: bytes
    nonce: bytes
    key_version: int


class CredentialVault:
    def __init__(self, key: bytes, *, key_version: int = 1) -> None:
        if len(key) != 32 or key_version < 1:
            raise ValueError("credential vault requires a versioned 256-bit key")
        self._cipher = AESGCM(key)
        self.key_version = key_version

    def encrypt(
        self,
        plaintext: str,
        scope: CredentialScope,
    ) -> EncryptedCredential:
        if not plaintext or len(plaintext.encode("utf-8")) > 4_096:
            raise ValueError("credential must be present and bounded")
        nonce = os.urandom(12)
        if len(nonce) != 12:
            raise ValueError("credential nonce must contain 96 bits")
        ciphertext = self._cipher.encrypt(nonce, plaintext.encode("utf-8"), scope.associated_data())
        return EncryptedCredential(
            ciphertext=ciphertext,
            nonce=nonce,
            key_version=self.key_version,
        )

    def decrypt(self, encrypted: EncryptedCredential, scope: CredentialScope) -> str:
        if encrypted.key_version != self.key_version or len(encrypted.nonce) != 12:
            raise CredentialDecryptionError("credential is unavailable")
        try:
            plaintext = self._cipher.decrypt(
                encrypted.nonce,
                encrypted.ciphertext,
                scope.associated_data(),
            )
            return plaintext.decode("utf-8")
        except (InvalidTag, UnicodeDecodeError, ValueError) as error:
            raise CredentialDecryptionError("credential is unavailable") from error


def credential_fingerprint(plaintext: str) -> str:
    if not plaintext:
        raise ValueError("credential is required")
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
