import hashlib
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

from app.ingest.models import ScanReport, ScanVerdict
from app.ingest.pipeline import UploadIntake
from app.jobs.preprocess import PreprocessWorker
from app.jobs.queue import JobQueue
from app.records.service import RecordService
from app.security.auth import AuthService
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


def _queued_document(tmp_path: Path) -> tuple[Database, Path, str, str]:
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
    object_root = tmp_path / "objects"
    records = RecordService(
        database,
        auth,
        UploadIntake(
            quarantine_root=tmp_path / "quarantine",
            object_store=ContentAddressedObjectStore(object_root),
            scanner=CleanScanner(),
            require_malware_scan=True,
        ),
    )
    profile = records.create_profile(
        owner.plaintext_token,
        owner.csrf_token,
        "Synthetic loved one",
        now=1_800_000_001,
    )
    payload = _png_bytes()
    document = records.upload_document(
        owner.plaintext_token,
        owner.csrf_token,
        profile.id,
        BytesIO(payload),
        original_name="synthetic.png",
        claimed_media_type="image/png",
        content_length=len(payload),
        now=1_800_000_002,
    )
    return database, object_root, str(document.id), document.source_sha256


def test_job_lease_is_exclusive_and_expired_lease_can_be_reclaimed(tmp_path: Path) -> None:
    database, _, _, _ = _queued_document(tmp_path)
    queue = JobQueue(database)

    first = queue.lease_next("preprocess", worker_id="worker-one", now=1_800_000_003)
    assert first is not None
    assert first.attempts == 1
    assert queue.lease_next("preprocess", worker_id="worker-two", now=1_800_000_004) is None

    second = queue.lease_next("preprocess", worker_id="worker-two", now=1_800_000_064)
    assert second is not None
    assert second.id == first.id
    assert second.attempts == 2
    assert second.lease_owner == "worker-two"


def test_preprocessor_verifies_source_and_completes_idempotently(tmp_path: Path) -> None:
    database, object_root, document_id, source_sha256 = _queued_document(tmp_path)
    worker = PreprocessWorker(
        database,
        ContentAddressedObjectStore(object_root),
        worker_id="worker-one",
    )

    assert worker.process_once(now=1_800_000_003) is True
    assert worker.process_once(now=1_800_000_004) is False

    with database.connect(read_only=True) as connection:
        document = connection.execute(
            "SELECT status, safe_error_code FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        job = connection.execute(
            "SELECT state, attempts, completed_at FROM jobs WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        artifacts = connection.execute(
            "SELECT page_number, sha256, storage_key FROM derived_artifacts "
            "WHERE document_id = ?",
            (document_id,),
        ).fetchall()

    assert document is not None and document["status"] == "ready"
    assert document["safe_error_code"] is None
    assert job is not None and job["state"] == "completed"
    assert int(job["attempts"]) == 1
    assert job["completed_at"] == 1_800_000_003
    assert len(artifacts) == 1
    assert artifacts[0]["page_number"] == 1
    assert artifacts[0]["sha256"] == source_sha256
    assert hashlib.sha256(_png_bytes()).hexdigest() == source_sha256
    assert not artifacts[0]["storage_key"].startswith("/")
