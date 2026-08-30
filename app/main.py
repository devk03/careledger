import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.health import router as health_router
from app.config import get_settings
from app.security.bootstrap import BootstrapManager
from app.security.headers import SecurityHeadersMiddleware

LOGGER = logging.getLogger("careledger")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    settings.ensure_directories()
    state = BootstrapManager(
        settings.secrets_dir,
        settings.public_base_url,
        token_ttl_seconds=settings.bootstrap_token_ttl_seconds,
    ).initialize()
    if state.setup_required and state.setup_url:
        LOGGER.warning("First-run setup URL: %s", state.setup_url)
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="CareLedger",
        description="A source-linked family health evidence workspace.",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(health_router)

    web_dist = get_settings().web_dist_dir
    assets = web_dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            requested = web_dist / path
            if requested.is_file() and requested.is_relative_to(web_dist):
                return FileResponse(requested)
            return FileResponse(web_dist / "index.html")

    return app


app = create_app()
