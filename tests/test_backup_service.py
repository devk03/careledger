from io import BytesIO
from pathlib import Path

import pytest

from app.backups.service import BackupService
from app.security.audit import verify_audit_chain
from app.security.auth import AuthError, AuthErrorCode, AuthService
from app.security.bootstrap import BootstrapManager
from app.security.passwords import PasswordManager
from app.storage.database import CURRENT_SCHEMA_VERSION, Database
from app.storage.objects import ContentAddressedObjectStore
from app.storage.portable_backup import inspect_portable_backup, restore_portable_backup

ACCOUNT_PASSWORD = "synthetic owner passphrase"  # noqa: S105
BACKUP_PASSPHRASE = "synthetic encrypted backup passphrase"  # noqa: S105


def _service(tmp_path: Path) -> tuple[Database, BackupService, str, str]:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    bootstrap = BootstrapManager(tmp_path / "secrets", "https://localhost:8080")
    state = bootstrap.initialize(setup_complete=False)
    assert state.setup_url is not None
    setup_token = (tmp_path / "secrets" / "bootstrap-token").read_text(encoding="utf-8")
    pepper = tmp_path / "secrets" / "recovery-pepper"
    pepper.write_bytes(b"r" * 32)
    pepper.chmod(0o600)
    auth = AuthService(
        database,
        bootstrap,
        pepper.read_bytes(),
        passwords=PasswordManager(time_cost=1, memory_cost=8_192, parallelism=1),
    )
    owner = auth.setup_owner(
        setup_token,
        ACCOUNT_PASSWORD,
        display_name="Synthetic organizer",
        household_name="Synthetic household",
        now=1_800_000_000,
    )
    objects = ContentAddressedObjectStore(tmp_path / "objects")
    objects.put(BytesIO(b"SYNTHETIC TEST RECORD - NOT A REAL PATIENT"))
    return (
        database,
        BackupService(database, auth, objects, tmp_path / "backups", pepper),
        owner.plaintext_token,
        owner.csrf_token,
    )


def test_owner_export_is_reauthenticated_encrypted_and_recoverable(tmp_path: Path) -> None:
    database, service, token, csrf = _service(tmp_path)

    exported = service.export(
        token,
        csrf,
        ACCOUNT_PASSWORD,
        BACKUP_PASSPHRASE,
        now=1_800_000_001,
    )
    manifest = inspect_portable_backup(exported.path, BACKUP_PASSPHRASE)
    restored = restore_portable_backup(
        exported.path,
        tmp_path / "restored",
        BACKUP_PASSPHRASE,
    )

    assert exported.path.stat().st_mode & 0o777 == 0o600
    assert exported.receipt.includes_database is True
    assert manifest.schema_version == CURRENT_SCHEMA_VERSION
    assert {member.kind for member in manifest.members} == {
        "application_secret",
        "source_object",
        "sqlite_snapshot",
    }
    assert restored.database_path is not None
    assert restored.database_path == tmp_path / "restored" / "app.sqlite"
    assert (tmp_path / "restored" / "secrets" / "recovery-pepper").read_bytes() == b"r" * 32
    with database.connect(read_only=True) as connection:
        assert verify_audit_chain(connection).ok is True


def test_wrong_account_password_creates_no_backup(tmp_path: Path) -> None:
    _, service, token, csrf = _service(tmp_path)

    with pytest.raises(AuthError) as rejected:
        service.export(
            token,
            csrf,
            "wrong synthetic account password",
            BACKUP_PASSPHRASE,
            now=1_800_000_001,
        )
    assert rejected.value.code == AuthErrorCode.INVALID_CREDENTIALS
    assert tuple((tmp_path / "backups").glob("*.clb")) == ()
