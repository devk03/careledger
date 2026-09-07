import base64
import hashlib
import hmac
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from urllib.parse import urlencode, urlsplit, urlunsplit

OPENROUTER_AUTH_URL = "https://openrouter.ai/auth"
OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys"
OPENROUTER_CURRENT_KEY_URL = "https://openrouter.ai/api/v1/key"

_FLOW_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_AUTHORIZATION_CODE = re.compile(r"^[A-Za-z0-9._~-]{1,512}$")
MAX_FLOW_TTL_SECONDS = 10 * 60


@dataclass(frozen=True, repr=False)
class PKCEAuthorization:
    flow_token: str
    code_verifier: str
    code_challenge: str
    callback_url: str
    authorization_url: str


@dataclass(frozen=True)
class OpenRouterIssuedKey:
    plaintext_key: str = field(repr=False)
    provider_user_id: str | None


@dataclass(frozen=True, repr=False)
class PendingOAuthFlow:
    flow_token_sha256: str
    code_verifier: str
    household_id: str
    user_id: str
    session_id: str
    created_at: int
    expires_at: int
    consumed_at: int | None = None


def create_pkce_authorization(
    public_base_url: str,
) -> PKCEAuthorization:
    origin = _validated_origin(public_base_url)
    flow_token = _base64url(os.urandom(32))
    verifier = _base64url(os.urandom(64))
    if not _FLOW_TOKEN.fullmatch(flow_token) or not 43 <= len(verifier) <= 128:
        raise ValueError("secure PKCE entropy is required")
    challenge = _base64url(hashlib.sha256(verifier.encode("ascii")).digest())
    callback_url = f"{origin}/api/ai/openrouter/callback/{flow_token}"
    query = urlencode(
        {
            "callback_url": callback_url,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return PKCEAuthorization(
        flow_token=flow_token,
        code_verifier=verifier,
        code_challenge=challenge,
        callback_url=callback_url,
        authorization_url=f"{OPENROUTER_AUTH_URL}?{query}",
    )


def normalize_authorization_code(value: str) -> str:
    if not _AUTHORIZATION_CODE.fullmatch(value):
        raise ValueError("OpenRouter authorization code has an invalid shape")
    return value


def parse_issued_key(payload: Mapping[str, object]) -> OpenRouterIssuedKey:
    key = payload.get("key")
    user_id = payload.get("user_id")
    if (
        not isinstance(key, str)
        or not key.startswith("sk-or-")
        or not 20 <= len(key) <= 512
        or any(character.isspace() for character in key)
    ):
        raise ValueError("OpenRouter returned an invalid credential")
    if user_id is not None and (
        not isinstance(user_id, str)
        or not re.fullmatch(r"[A-Za-z0-9._~-]{1,256}", user_id)
    ):
        raise ValueError("OpenRouter returned an invalid user identifier")
    return OpenRouterIssuedKey(plaintext_key=key, provider_user_id=user_id)


def pending_flow(
    authorization: PKCEAuthorization,
    *,
    household_id: str,
    user_id: str,
    session_id: str,
    created_at: int,
) -> PendingOAuthFlow:
    identifiers = (household_id, user_id, session_id)
    if created_at < 1 or any(not value or len(value) > 256 for value in identifiers):
        raise ValueError("OAuth flow scope is invalid")
    return PendingOAuthFlow(
        flow_token_sha256=_flow_token_sha256(authorization.flow_token),
        code_verifier=authorization.code_verifier,
        household_id=household_id,
        user_id=user_id,
        session_id=session_id,
        created_at=created_at,
        expires_at=created_at + MAX_FLOW_TTL_SECONDS,
    )


def consume_pending_flow(
    flow: PendingOAuthFlow,
    *,
    flow_token: str,
    household_id: str,
    user_id: str,
    session_id: str,
    now: int,
) -> PendingOAuthFlow:
    if (
        flow.consumed_at is not None
        or now < flow.created_at
        or now >= flow.expires_at
        or flow.expires_at - flow.created_at > MAX_FLOW_TTL_SECONDS
        or not hmac.compare_digest(flow.flow_token_sha256, _flow_token_sha256(flow_token))
        or not hmac.compare_digest(flow.household_id, household_id)
        or not hmac.compare_digest(flow.user_id, user_id)
        or not hmac.compare_digest(flow.session_id, session_id)
    ):
        raise ValueError("OAuth flow is invalid or expired")
    # The repository must persist this transition with a conditional UPDATE in the same
    # transaction that loads the flow, before exchanging the authorization code.
    return replace(flow, consumed_at=now)


def exchange_payload(code: str, verifier: str) -> dict[str, str]:
    normalized_code = normalize_authorization_code(code)
    if not 43 <= len(verifier) <= 128 or not re.fullmatch(r"[A-Za-z0-9._~-]+", verifier):
        raise ValueError("PKCE verifier has an invalid shape")
    return {
        "code": normalized_code,
        "code_verifier": verifier,
        "code_challenge_method": "S256",
    }


def _validated_origin(value: str) -> str:
    parsed = urlsplit(value)
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
    if parsed.scheme != "https" and not local_http:
        raise ValueError("OpenRouter callbacks require HTTPS except on localhost")
    if (
        not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("PUBLIC_BASE_URL must be an origin without credentials or a path")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _flow_token_sha256(value: str) -> str:
    if not _FLOW_TOKEN.fullmatch(value):
        raise ValueError("OAuth flow token has an invalid shape")
    return hashlib.sha256(value.encode("ascii")).hexdigest()
