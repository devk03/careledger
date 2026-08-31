import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.analysis.service import AnalysisService
from app.analysis.worker import BackgroundExtractionWorker, ExtractionWorker
from app.api.analysis import router as analysis_router
from app.api.auth import router as auth_router
from app.api.backups import router as backups_router
from app.api.evidence import router as evidence_router
from app.api.health import router as health_router
from app.api.records import router as records_router
from app.api.search import router as search_router
from app.api.workspace import router as workspace_router
from app.backups.service import BackupService
from app.config import get_settings
from app.evidence.review import EvidenceReviewService
from app.jobs.preprocess import BackgroundPreprocessWorker, PreprocessWorker
from app.records.content import DocumentContentService
from app.records.service import build_record_service
from app.search.service import EvidenceSearchService
from app.security.auth import AuthService
from app.security.bootstrap import BootstrapManager
from app.security.headers import SecurityHeadersMiddleware
from app.security.local_secrets import load_or_create_secret
from app.security.request_limits import ONE_MEBIBYTE, UploadBodyLimitMiddleware
from app.storage.database import Database
from app.storage.objects import ContentAddressedObjectStore
from app.workspace.service import CareWorkspaceService

LOGGER = logging.getLogger("careledger")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    settings.ensure_directories()
    database = Database(settings.database_path)
    database.initialize()
    manager = BootstrapManager(
        settings.secrets_dir,
        settings.public_base_url,
        token_ttl_seconds=settings.bootstrap_token_ttl_seconds,
    )
    app.state.database = database
    app.state.bootstrap_manager = manager
    auth_service = AuthService(
        database,
        manager,
        load_or_create_secret(settings.secrets_dir / "recovery-pepper"),
    )
    app.state.auth_service = auth_service
    app.state.record_service = build_record_service(
        database,
        auth_service,
        quarantine_root=settings.quarantine_dir,
        object_root=settings.object_dir,
        max_upload_bytes=settings.max_upload_bytes,
        max_pdf_pages=settings.max_pdf_pages,
        max_image_pixels=settings.max_image_pixels,
        max_image_dimension=settings.max_image_dimension,
    )
    app.state.document_content_service = DocumentContentService(
        database,
        auth_service,
        ContentAddressedObjectStore(settings.object_dir),
    )
    ai_provider = settings.ai_runtime()
    app.state.analysis_service = AnalysisService(database, auth_service, ai_provider)
    app.state.evidence_review_service = EvidenceReviewService(database, auth_service)
    app.state.care_workspace_service = CareWorkspaceService(database, auth_service)
    app.state.backup_service = BackupService(
        database,
        auth_service,
        ContentAddressedObjectStore(settings.object_dir),
        settings.backup_dir,
        settings.secrets_dir / "recovery-pepper",
    )
    app.state.evidence_search_service = EvidenceSearchService(database, auth_service)
    state = manager.initialize(setup_complete=database.is_setup_complete())
    if state.setup_required and state.setup_url:
        LOGGER.warning("First-run setup URL: %s", state.setup_url)
    preprocess = BackgroundPreprocessWorker(
        PreprocessWorker(
            database,
            ContentAddressedObjectStore(settings.object_dir),
            worker_id=f"web-{id(app)}",
        )
    )
    extraction = BackgroundExtractionWorker(
        ExtractionWorker(
            database,
            ContentAddressedObjectStore(settings.object_dir),
            ai_provider,
            safety_secret=load_or_create_secret(settings.secrets_dir / "ai-safety-secret"),
            worker_id=f"ai-{id(app)}",
        )
    )
    worker_task = asyncio.create_task(preprocess.run(), name="careledger-preprocess")
    extraction_task = asyncio.create_task(extraction.run(), name="careledger-extraction")
    app.state.preprocess_worker = preprocess
    app.state.extraction_worker = extraction
    try:
        yield
    finally:
        preprocess.stop()
        extraction.stop()
        await worker_task
        await extraction_task


def create_app() -> FastAPI:
    app = FastAPI(
        title="CareLedger",
        description="A source-linked family health evidence workspace.",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    settings = get_settings()
    app.add_middleware(
        UploadBodyLimitMiddleware,
        max_bytes=settings.max_upload_bytes + ONE_MEBIBYTE,
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(records_router)
    app.include_router(analysis_router)
    app.include_router(evidence_router)
    app.include_router(workspace_router)
    app.include_router(backups_router)
    app.include_router(search_router)

    web_dist = settings.web_dist_dir
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
