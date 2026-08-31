import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from typing import Literal
from uuid import UUID


@dataclass(frozen=True)
class IssuedSessionToken:
    plaintext: str
    sha256: str


@dataclass(frozen=True)
class RecoveryCodeSet:
    plaintext_codes: tuple[str, ...]
    hmac_sha256: tuple[str, ...]


@dataclass(frozen=True)
class SessionCookiePolicy:
    name: str = "__Host-careledger_session"
    path: str = "/"
    http_only: bool = True
    secure: bool = True
    same_site: Literal["strict"] = "strict"
    max_age_seconds: int = 8 * 60 * 60


def issue_session_token() -> IssuedSessionToken:
    plaintext = secrets.token_urlsafe(32)
    return IssuedSessionToken(plaintext=plaintext, sha256=hash_session_token(plaintext))


def hash_session_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_recovery_codes(pepper: bytes, *, count: int = 10) -> RecoveryCodeSet:
    if len(pepper) < 32:
        raise ValueError("a 32-byte local recovery-code pepper is required")
    if not 1 <= count <= 20:
        raise ValueError("recovery code count must be between 1 and 20")
    plaintext: list[str] = []
    hashes: list[str] = []
    for _ in range(count):
        compact = base64.b32encode(secrets.token_bytes(10)).decode("ascii").rstrip("=")
        code = "-".join(compact[index : index + 4] for index in range(0, len(compact), 4))
        plaintext.append(code)
        hashes.append(_recovery_hash(code, pepper))
    return RecoveryCodeSet(tuple(plaintext), tuple(hashes))


def verify_recovery_code(code: str, expected_hash: str, pepper: bytes) -> bool:
    if len(pepper) < 32:
        return False
    return hmac.compare_digest(_recovery_hash(code, pepper), expected_hash)


def issue_csrf_token(session_id: UUID, secret: bytes) -> str:
    if len(secret) < 32:
        raise ValueError("a 32-byte session CSRF secret is required")
    nonce = secrets.token_urlsafe(24)
    mac = _csrf_mac(session_id, nonce, secret)
    return f"v1.{nonce}.{mac}"


def verify_csrf_token(token: str, session_id: UUID, secret: bytes) -> bool:
    if len(secret) < 32:
        return False
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1" or not parts[1] or not parts[2]:
        return False
    expected = _csrf_mac(session_id, parts[1], secret)
    return hmac.compare_digest(expected, parts[2])


def _recovery_hash(code: str, pepper: bytes) -> str:
    normalized = code.replace("-", "").strip().upper()
    return hmac.new(pepper, normalized.encode("ascii", errors="ignore"), hashlib.sha256).hexdigest()


def _csrf_mac(session_id: UUID, nonce: str, secret: bytes) -> str:
    message = f"v1:{session_id}:{nonce}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()
