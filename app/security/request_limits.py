import json
from collections.abc import Awaitable, Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

ONE_MEBIBYTE = 1024 * 1024


class RequestBodyTooLarge(Exception):
    pass


class UploadBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not _is_upload_request(scope):
            await self.app(scope, receive, send)
            return

        content_length = _content_length(scope)
        if content_length is not None and content_length > self.max_bytes:
            await _send_too_large(send)
            return

        received = 0

        async def receive_bounded() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise RequestBodyTooLarge
            return message

        try:
            await self.app(scope, receive_bounded, send)
        except RequestBodyTooLarge:
            await _send_too_large(send)


def _is_upload_request(scope: Scope) -> bool:
    if scope["type"] != "http" or scope.get("method") != "POST":
        return False
    parts = str(scope.get("path", "")).strip("/").split("/")
    return len(parts) == 4 and parts[:2] == ["api", "care-profiles"] and parts[3] == "documents"


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name.lower() == b"content-length":
            try:
                parsed = int(value)
            except ValueError:
                return None
            return max(parsed, 0)
    return None


async def _send_too_large(send: Callable[[Message], Awaitable[None]]) -> None:
    body = json.dumps(
        {"error": "UPLOAD_TOO_LARGE", "message": "This upload is larger than the safety limit."},
        separators=(",", ":"),
    ).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
