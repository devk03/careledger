from enum import StrEnum

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError


class PasswordErrorCode(StrEnum):
    TOO_SHORT = "TOO_SHORT"
    TOO_LONG = "TOO_LONG"
    INVALID_CHARACTER = "INVALID_CHARACTER"


class PasswordPolicyError(ValueError):
    def __init__(self, code: PasswordErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


class PasswordManager:
    def __init__(
        self,
        *,
        time_cost: int = 3,
        memory_cost: int = 65_536,
        parallelism: int = 4,
        hash_len: int = 32,
        salt_len: int = 16,
    ) -> None:
        self._hasher = PasswordHasher(
            time_cost=time_cost,
            memory_cost=memory_cost,
            parallelism=parallelism,
            hash_len=hash_len,
            salt_len=salt_len,
            type=Type.ID,
        )

    def hash(self, password: str) -> str:
        validate_password(password)
        return self._hasher.hash(password)

    def verify(self, encoded_hash: str, password: str) -> bool:
        try:
            return self._hasher.verify(encoded_hash, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    def needs_rehash(self, encoded_hash: str) -> bool:
        try:
            return self._hasher.check_needs_rehash(encoded_hash)
        except InvalidHashError:
            return True


def validate_password(password: str) -> None:
    if len(password) < 12:
        raise PasswordPolicyError(PasswordErrorCode.TOO_SHORT)
    if len(password) > 128:
        raise PasswordPolicyError(PasswordErrorCode.TOO_LONG)
    if "\x00" in password:
        raise PasswordPolicyError(PasswordErrorCode.INVALID_CHARACTER)
