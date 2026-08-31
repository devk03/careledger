import json
from pathlib import Path
from uuid import UUID

import pytest

from app.ai.provider import AIProvider, AIProviderRuntime
from app.analysis.service import AnalysisError, AnalysisErrorCode, AnalysisService
from app.security.audit import verify_audit_chain
from app.security.auth import AuthService
from app.security.bootstrap import BootstrapManager
from app.security.tokens import hash_session_token, issue_csrf_token
from app.storage.database import Database

HOUSEHOLD_ID = "00000000-0000-0000-0000-000000000110"
USER_ID = "00000000-0000-0000-0000-000000000120"
PROFILE_ID = "00000000-0000-0000-0000-000000000130"
DOCUMENT_ID = UUID("00000000-0000-0000-0000-000000000140")
SESSION_ID = UUID("00000000-0000-0000-0000-000000000150")
SESSION_TOKEN = "synthetic-analysis-session"  # noqa: S105
CSRF_SECRET = b"s" * 32
SOURCE_SHA256 = "d" * 64


def _services(tmp_path: Path) -> tuple[Database, AuthService]:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO households (singleton, id, display_name, created_at) "
            "VALUES (1, ?, 'Synthetic household', 1)",
            (HOUSEHOLD_ID,),
        )
        connection.execute(
            "INSERT INTO users "
            "(id, household_id, login_name, login_name_normalized, display_name, role, status, "
            "password_hash, auth_version, created_at, updated_at, password_changed_at, "
            "disabled_at) VALUES (?, ?, 'owner', 'owner', 'Synthetic organizer', 'owner', "
            "'active', '$argon2id$synthetic', 1, 1, 1, 1, NULL)",
            (USER_ID, HOUSEHOLD_ID),
        )
        connection.execute(
            "INSERT INTO care_profiles "
            "(id, household_id, preferred_name, birth_date, created_by, created_at, updated_at, "
            "archived_at) VALUES (?, ?, 'Synthetic loved one', NULL, ?, 1, 1, NULL)",
            (PROFILE_ID, HOUSEHOLD_ID, USER_ID),
        )
        connection.execute(
            "INSERT INTO source_objects (sha256, byte_size, media_type, created_at) "
            "VALUES (?, 12, 'application/pdf', 1)",
            (SOURCE_SHA256,),
        )
        connection.execute(
            "INSERT INTO documents "
            "(id, care_profile_id, source_sha256, original_display_name, scan_verdict, page_count, "
            "status, uploaded_by, uploaded_at, archived_at) VALUES "
            "(?, ?, ?, 'synthetic.pdf', 'clean', 1, 'ready', ?, 1, NULL)",
            (str(DOCUMENT_ID), PROFILE_ID, SOURCE_SHA256, USER_ID),
        )
        connection.execute(
            "INSERT INTO sessions "
            "(id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, "
            "last_seen_at, revoked_at) VALUES (?, ?, ?, ?, 1, 1, 9999999999, 1, NULL)",
            (
                str(SESSION_ID),
                USER_ID,
                hash_session_token(SESSION_TOKEN),
                CSRF_SECRET,
            ),
        )
    return (
        database,
        AuthService(
            database,
            BootstrapManager(tmp_path / "secrets", "https://localhost:8080"),
            b"r" * 32,
        ),
    )


def test_analysis_requires_transfer_confirmation_and_queues_no_secrets(tmp_path: Path) -> None:
    database, auth = _services(tmp_path)
    runtime = AIProviderRuntime(
        AIProvider.OPENROUTER,
        "synthetic/model",
        "synthetic-provider-key",  # noqa: S106
        "https://openrouter.ai/api/v1",
    )
    service = AnalysisService(database, auth, runtime)
    csrf = issue_csrf_token(SESSION_ID, CSRF_SECRET)

    with pytest.raises(AnalysisError) as unconfirmed:
        service.request_analysis(
            SESSION_TOKEN,
            csrf,
            DOCUMENT_ID,
            acknowledge_external_transfer=False,
            now=2,
        )
    assert unconfirmed.value.code == AnalysisErrorCode.EXTERNAL_TRANSFER_NOT_CONFIRMED

    first = service.request_analysis(
        SESSION_TOKEN,
        csrf,
        DOCUMENT_ID,
        acknowledge_external_transfer=True,
        now=2,
    )
    second = service.request_analysis(
        SESSION_TOKEN,
        csrf,
        DOCUMENT_ID,
        acknowledge_external_transfer=True,
        now=3,
    )

    assert first.job_id == second.job_id
    assert first.state == "queued"
    assert first.already_requested is False
    assert second.already_requested is True
    with database.connect(read_only=True) as connection:
        job = connection.execute(
            "SELECT payload_json, payload_sha256, idempotency_key FROM jobs "
            "WHERE job_type = 'extract'"
        ).fetchone()
        job_count = connection.execute(
            "SELECT COUNT(*) FROM jobs WHERE job_type = 'extract'"
        ).fetchone()[0]
        audit = verify_audit_chain(connection)

    assert job is not None and job_count == 1
    assert "synthetic-provider-key" not in job["payload_json"]
    assert json.loads(job["payload_json"])["provider"] == "openrouter"
    assert job["payload_sha256"] not in job["payload_json"]
    assert "extract-v1" in job["idempotency_key"]
    assert audit.ok is True


def test_disabled_ai_never_creates_an_analysis_job(tmp_path: Path) -> None:
    database, auth = _services(tmp_path)
    service = AnalysisService(
        database,
        auth,
        AIProviderRuntime(AIProvider.DISABLED, None, None, None),
    )

    with pytest.raises(AnalysisError) as disabled:
        service.request_analysis(
            SESSION_TOKEN,
            issue_csrf_token(SESSION_ID, CSRF_SECRET),
            DOCUMENT_ID,
            acknowledge_external_transfer=True,
            now=2,
        )
    assert disabled.value.code == AnalysisErrorCode.AI_NOT_CONFIGURED
    with database.connect(read_only=True) as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
