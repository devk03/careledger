from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_SECURITY_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Permitted-Cross-Domain-Policies": "none",
}


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, *, allow_browser_openrouter: bool = False) -> None:
        self.app = app
        self._headers = {
            **_SECURITY_HEADERS,
            "Content-Security-Policy": content_security_policy(
                allow_browser_openrouter=allow_browser_openrouter
            ),
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path", ""))

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in self._headers.items():
                    headers[name] = value
                if (
                    path.startswith("/api/")
                    or path.startswith("/health/")
                    or path.startswith("/openrouter/callback/")
                ):
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_with_headers)


def content_security_policy(*, allow_browser_openrouter: bool) -> str:
    connect_sources = "connect-src 'self'"
    if allow_browser_openrouter:
        connect_sources += " https://openrouter.ai"
    return "; ".join(
        (
            "default-src 'self'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "object-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "font-src 'self'",
            "img-src 'self' data: blob:",
            connect_sources,
            "media-src 'none'",
            "worker-src 'self' blob:",
        )
    )
