import hashlib
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.config import get_settings
from app.ingest.models import ScanReport, ScanVerdict
from app.ingest.pipeline import UploadIntake
from app.main import create_app
from app.records.service import RecordService
from app.security.auth import AuthError, AuthErrorCode, AuthService
from app.security.bootstrap import BootstrapManager
from app.security.passwords import PasswordManager
from app.storage.database import Database
from app.storage.objects import ContentAddressedObjectStore

SYNTHETIC_LABEL = "SYNTHETIC TEST RECORD - NOT A REAL PATIENT"


class CleanScanner:
    def scan(self, path: Path) -> ScanReport:
        assert path.is_file()
        return ScanReport(ScanVerdict.CLEAN, "synthetic-scanner")


def _png_bytes() -> bytes:
    image = Image.new("RGB", (640, 240), color=(248, 243, 236))
    ImageDraw.Draw(image).text((24, 96), SYNTHETIC_LABEL, fill=(32, 32, 32))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _services(tmp_path: Path) -> tuple[RecordService, AuthService, str, str]:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    bootstrap = BootstrapManager(tmp_path / "secrets", "https://localhost:8080")
    state = bootstrap.initialize(setup_complete=False)
    assert state.setup_url is not None
    token = (tmp_path / "secrets" / "bootstrap-token").read_text(encoding="utf-8")
    auth = AuthService(
        database,
        bootstrap,
        b"r" * 32,
        passwords=PasswordManager(time_cost=1, memory_cost=8_192, parallelism=1),
    )
    owner = auth.setup_owner(
        token,
        "synthetic owner passphrase",
        display_name="Synthetic organizer",
        household_name="Synthetic household",
        now=1_800_000_000,
    )
    intake = UploadIntake(
        quarantine_root=tmp_path / "quarantine",
        object_store=ContentAddressedObjectStore(tmp_path / "objects"),
        scanner=CleanScanner(),
        require_malware_scan=True,
    )
    return RecordService(database, auth, intake), auth, owner.plaintext_token, owner.csrf_token


def test_profile_and_duplicate_documents_persist_with_one_immutable_source(tmp_path: Path) -> None:
    records, _, session_token, csrf = _services(tmp_path)
    profile = records.create_profile(
        session_token,
        csrf,
        "Synthetic loved one",
        now=1_800_000_001,
    )
    payload = _png_bytes()

    first = records.upload_document(
        session_token,
        csrf,
        profile.id,
        BytesIO(payload),
        original_name="synthetic record.png",
        claimed_media_type="image/png",
        content_length=len(payload),
        now=1_800_000_002,
    )
    second = records.upload_document(
        session_token,
        csrf,
        profile.id,
        BytesIO(payload),
        original_name="synthetic copy.png",
        claimed_media_type="image/png",
        content_length=len(payload),
        now=1_800_000_003,
    )

    assert first.source_sha256 == hashlib.sha256(payload).hexdigest()
    assert first.duplicate_source is False
    assert second.duplicate_source is True
    assert second.id != first.id
    assert len(records.list_profiles(session_token)) == 1
    assert len(records.list_documents(session_token, profile.id)) == 2
    object_files = tuple((tmp_path / "objects").glob("*/*/*"))
    assert len(object_files) == 1
    assert object_files[0].read_bytes() == payload


def test_mutation_requires_csrf_bound_to_the_session(tmp_path: Path) -> None:
    records, _, session_token, _ = _services(tmp_path)

    with pytest.raises(AuthError) as rejected:
        records.create_profile(session_token, "wrong-csrf", "Synthetic loved one")
    assert rejected.value.code == AuthErrorCode.INVALID_CSRF
    assert records.list_profiles(session_token) == ()


def test_profile_upload_http_flow_returns_provenance_not_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://localhost:8080")
    get_settings.cache_clear()

    with TestClient(create_app(), base_url="https://localhost:8080") as client:
        token = (tmp_path / "secrets" / "bootstrap-token").read_text(encoding="utf-8")
        setup = client.post(
            "/api/auth/setup",
            headers={"Origin": "https://localhost:8080", "Sec-Fetch-Site": "same-origin"},
            json={
                "token": token,
                "password": "synthetic owner passphrase",
                "display_name": "Synthetic organizer",
                "household_name": "Synthetic household",
            },
        )
        csrf = setup.json()["csrf_token"]
        mutation_headers = {
            "Origin": "https://localhost:8080",
            "Sec-Fetch-Site": "same-origin",
            "X-CSRF-Token": csrf,
        }
        profile = client.post(
            "/api/care-profiles",
            headers=mutation_headers,
            json={"preferred_name": "Synthetic loved one"},
        )
        assert profile.status_code == 201
        profile_id = profile.json()["id"]
        payload = _png_bytes()
        uploaded = client.post(
            f"/api/care-profiles/{profile_id}/documents",
            headers=mutation_headers,
            files={"record": ("synthetic.png", payload, "image/png")},
        )

        assert uploaded.status_code == 201
        body = uploaded.json()
        assert body["source_sha256"] == hashlib.sha256(payload).hexdigest()
        assert body["display_name"] == "synthetic.png"
        assert body["page_count"] == 1
        assert "path" not in body
        documents = client.get(f"/api/care-profiles/{profile_id}/documents")
        assert documents.status_code == 200
        assert [item["id"] for item in documents.json()] == [body["id"]]
        original = client.get(f"/api/documents/{body['id']}/content")
        assert original.status_code == 200
        assert original.content == payload
        assert original.headers["content-type"] == "image/png"
        assert original.headers["content-disposition"] == "inline"
        assert original.headers["etag"] == f'"sha256-{body["source_sha256"]}"'
        assert str(tmp_path) not in original.text

    get_settings.cache_clear()
