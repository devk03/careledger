import sqlite3
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path

import pytest

from app.storage.objects import ContentAddressedObjectStore
from app.storage.portable_backup import (
    BackupErrorCode,
    BackupRejected,
    export_portable_backup,
    inspect_portable_backup,
    restore_portable_backup,
    validate_backup_member_path,
)
from app.storage.sqlite_snapshot import create_sqlite_snapshot

CANARY = b"SYNTHETIC TEST RECORD - NOT A REAL PATIENT - PORTABLE BACKUP"
PASSPHRASE = "synthetic portable backup passphrase"  # noqa: S105


def _synthetic_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE synthetic_records (id INTEGER PRIMARY KEY, note TEXT)")
        connection.execute(
            "INSERT INTO synthetic_records (note) VALUES (?)",
            (CANARY.decode(),),
        )
        connection.commit()
    finally:
        connection.close()


def _export_fixture(tmp_path: Path) -> tuple[Path, ContentAddressedObjectStore, bytes, Path]:
    store = ContentAddressedObjectStore(tmp_path / "source" / "objects" / "sha256")
    payload = CANARY + b"\n" + b"x" * (1024 * 1024 + 257)
    store.put(BytesIO(payload))
    live_database = tmp_path / "synthetic-live.sqlite"
    snapshot = tmp_path / "synthetic-snapshot.sqlite"
    recovery_pepper = tmp_path / "synthetic-recovery-pepper"
    recovery_pepper.write_bytes(b"r" * 32)
    _synthetic_database(live_database)
    create_sqlite_snapshot(live_database, snapshot)
    backup = tmp_path / "careledger-backup.clb"
    export_portable_backup(
        store,
        backup,
        PASSPHRASE,
        database_snapshot=snapshot,
        recovery_pepper=recovery_pepper,
        created_at=datetime(2026, 2, 3, tzinfo=UTC),
    )
    return backup, store, payload, snapshot


def test_encrypted_backup_round_trip_preserves_objects_and_sqlite(tmp_path: Path) -> None:
    backup, source_store, payload, _ = _export_fixture(tmp_path)

    assert CANARY not in backup.read_bytes()
    assert backup.stat().st_mode & 0o777 == 0o600
    manifest = inspect_portable_backup(backup, PASSPHRASE)
    assert manifest.format == "careledger.portable.v1"
    assert {member.kind for member in manifest.members} == {
        "application_secret",
        "source_object",
        "sqlite_snapshot",
    }

    restored_root = tmp_path / "restored"
    receipt = restore_portable_backup(backup, restored_root, PASSPHRASE)
    restored_store = ContentAddressedObjectStore(restored_root / "objects" / "sha256")

    assert receipt.object_count == 1
    assert restored_store.iter_digests() == source_store.iter_digests()
    digest = restored_store.iter_digests()[0]
    assert restored_store.path_for(digest).read_bytes() == payload
    assert receipt.database_path is not None
    assert receipt.database_path == restored_root / "app.sqlite"
    connection = sqlite3.connect(receipt.database_path)
    try:
        note = connection.execute("SELECT note FROM synthetic_records").fetchone()
    finally:
        connection.close()
    assert note == (CANARY.decode(),)
    assert (restored_root / "secrets" / "recovery-pepper").read_bytes() == b"r" * 32
    assert (restored_root / "secrets" / "recovery-pepper").stat().st_mode & 0o777 == 0o600


def test_randomized_exports_never_repeat_ciphertext(tmp_path: Path) -> None:
    backup, store, _, snapshot = _export_fixture(tmp_path)
    second = tmp_path / "careledger-backup-2.clb"
    export_portable_backup(
        store,
        second,
        PASSPHRASE,
        database_snapshot=snapshot,
        recovery_pepper=tmp_path / "synthetic-recovery-pepper",
        created_at=datetime(2026, 2, 3, tzinfo=UTC),
    )

    assert backup.read_bytes() != second.read_bytes()


@pytest.mark.parametrize("mutation", ["wrong-passphrase", "bit-flip", "truncate"])
def test_wrong_passphrase_or_corruption_fails_closed(tmp_path: Path, mutation: str) -> None:
    backup, _, _, _ = _export_fixture(tmp_path)
    candidate = backup
    passphrase = PASSPHRASE
    if mutation == "wrong-passphrase":
        passphrase = "wrong synthetic backup passphrase"  # noqa: S105
    else:
        modified = bytearray(backup.read_bytes())
        if mutation == "bit-flip":
            modified[len(modified) // 2] ^= 0x01
        else:
            modified = modified[:-23]
        candidate = tmp_path / f"{mutation}.clb"
        candidate.write_bytes(modified)

    with pytest.raises(BackupRejected) as rejected:
        restore_portable_backup(candidate, tmp_path / f"restore-{mutation}", passphrase)
    assert rejected.value.code in {
        BackupErrorCode.CRYPTO_FAILURE,
        BackupErrorCode.INVALID_ARCHIVE,
    }
    assert not (tmp_path / f"restore-{mutation}").exists()


def test_restore_refuses_any_existing_destination(tmp_path: Path) -> None:
    backup, _, _, _ = _export_fixture(tmp_path)
    destination = tmp_path / "existing"
    destination.mkdir()

    with pytest.raises(BackupRejected) as rejected:
        restore_portable_backup(backup, destination, PASSPHRASE)
    assert rejected.value.code == BackupErrorCode.DESTINATION_NOT_EMPTY


@pytest.mark.parametrize(
    "unsafe",
    ["../escape", "/absolute", "folder/../escape", "C:/windows", "folder\\file"],
)
def test_restore_member_paths_reject_traversal_and_platform_paths(unsafe: str) -> None:
    with pytest.raises(BackupRejected) as rejected:
        validate_backup_member_path(unsafe)
    assert rejected.value.code == BackupErrorCode.INVALID_ARCHIVE
