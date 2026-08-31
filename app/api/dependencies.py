from typing import cast

from fastapi import Request

from app.analysis.service import AnalysisService
from app.backups.service import BackupService
from app.evidence.review import EvidenceReviewService
from app.records.content import DocumentContentService
from app.records.service import RecordService
from app.search.service import EvidenceSearchService
from app.security.auth import AuthService
from app.security.bootstrap import BootstrapManager
from app.storage.database import Database
from app.workspace.service import CareWorkspaceService


def database(request: Request) -> Database:
    return cast(Database, request.app.state.database)


def bootstrap_manager(request: Request) -> BootstrapManager:
    return cast(BootstrapManager, request.app.state.bootstrap_manager)


def auth_service(request: Request) -> AuthService:
    return cast(AuthService, request.app.state.auth_service)


def record_service(request: Request) -> RecordService:
    return cast(RecordService, request.app.state.record_service)


def analysis_service(request: Request) -> AnalysisService:
    return cast(AnalysisService, request.app.state.analysis_service)


def evidence_review_service(request: Request) -> EvidenceReviewService:
    return cast(EvidenceReviewService, request.app.state.evidence_review_service)


def document_content_service(request: Request) -> DocumentContentService:
    return cast(DocumentContentService, request.app.state.document_content_service)


def care_workspace_service(request: Request) -> CareWorkspaceService:
    return cast(CareWorkspaceService, request.app.state.care_workspace_service)


def backup_service(request: Request) -> BackupService:
    return cast(BackupService, request.app.state.backup_service)


def evidence_search_service(request: Request) -> EvidenceSearchService:
    return cast(EvidenceSearchService, request.app.state.evidence_search_service)
