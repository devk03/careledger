import asyncio
import json

from starlette.types import Message, Receive, Scope, Send

from app.security.request_limits import UploadBodyLimitMiddleware


def _scope(*, content_length: int | None = None) -> Scope:
    headers = [] if content_length is None else [(b"content-length", str(content_length).encode())]
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "server": ("localhost", 8080),
        "client": ("127.0.0.1", 40000),
        "scheme": "https",
        "method": "POST",
        "root_path": "",
        "path": "/api/care-profiles/profile-test/documents",
        "raw_path": b"/api/care-profiles/profile-test/documents",
        "query_string": b"",
        "headers": headers,
    }


def test_declared_oversized_upload_is_rejected_without_reading_body() -> None:
    called = False
    body_read = False
    sent: list[Message] = []

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        nonlocal called
        called = True

    async def receive() -> Message:
        nonlocal body_read
        body_read = True
        return {"type": "http.request", "body": b"content", "more_body": False}

    async def send(message: Message) -> None:
        sent.append(message)

    middleware = UploadBodyLimitMiddleware(app, max_bytes=10)
    asyncio.run(middleware(_scope(content_length=11), receive, send))

    assert called is False
    assert body_read is False
    assert sent[0]["status"] == 413
    assert json.loads(sent[1]["body"])["error"] == "UPLOAD_TOO_LARGE"


def test_chunked_oversized_upload_is_stopped_before_parser_receives_extra_bytes() -> None:
    messages = iter(
        (
            {"type": "http.request", "body": b"123456", "more_body": True},
            {"type": "http.request", "body": b"78901", "more_body": False},
        )
    )
    sent: list[Message] = []

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        await receive()
        await receive()

    async def receive() -> Message:
        return next(messages)

    async def send(message: Message) -> None:
        sent.append(message)

    middleware = UploadBodyLimitMiddleware(app, max_bytes=10)
    asyncio.run(middleware(_scope(), receive, send))

    assert sent[0]["status"] == 413
