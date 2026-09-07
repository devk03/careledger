"""Operator access gate for the unfinished hosted preview."""

import base64
import binascii
import hmac
from contextlib import suppress

from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class StagingAccessMiddleware:
    def __init__(self, app: ASGIApp, *, password: str) -> None:
        self.app = app
        self._expected = ("adeno:" + password).encode("utf-8")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope.get("method") == "GET" and scope.get("path") in {
            "/health/live", "/health/ready"
        }:
            await self.app(scope, receive, send)
            return
        headers = [v for k, v in scope.get("headers", []) if k.lower() == b"authorization"]
        supplied = b""
        if len(headers) == 1 and len(headers[0]) <= 2048:
            scheme, _, value = headers[0].partition(b" ")
            if scheme.lower() == b"basic":
                with suppress(ValueError, binascii.Error):
                    supplied = base64.b64decode(value, validate=True)
        if not hmac.compare_digest(supplied, self._expected):
            response = PlainTextResponse(
                "Adeno private preview. Operator access is required. Use fictional records only.",
                status_code=401,
                headers={
                    "WWW-Authenticate": 'Basic realm="Adeno private preview", charset="UTF-8"',
                    "Cache-Control": "no-store",
                },
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)
