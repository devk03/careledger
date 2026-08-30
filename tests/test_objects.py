import hashlib
from io import BytesIO
from pathlib import Path

import pytest

from app.storage.integrity import (
    build_object_manifest,
    read_manifest,
    verify_object_manifest,
    write_manifest_atomic,
)
from app.storage.objects import ContentAddressedObjectStore, ObjectIntegrityError


def test_object_store_hashes_deduplicates_and_verifies(tmp_path: Path) -> None:
    store = ContentAddressedObjectStore(tmp_path)
    payload = b"SYNTHETIC TEST RECORD - NOT A REAL PATIENT"
    expected = hashlib.sha256(payload).hexdigest()

    first = store.put(BytesIO(payload))
    second = store.put(BytesIO(payload))

    assert first.digest == expected
    assert first.already_existed is False
    assert second.already_existed is True
    assert store.verify(expected) is True
    assert first.path.read_bytes() == payload


def test_object_store_rejects_untrusted_digest_paths(tmp_path: Path) -> None:
    store = ContentAddressedObjectStore(tmp_path)
    with pytest.raises(ValueError, match="SHA-256"):
        store.path_for("../../private")


def test_existing_corrupt_object_is_never_silently_deduplicated(tmp_path: Path) -> None:
    store = ContentAddressedObjectStore(tmp_path)
    payload = b"SYNTHETIC TEST RECORD - NOT A REAL PATIENT"
    stored = store.put(BytesIO(payload))
    stored.path.chmod(0o600)
    stored.path.write_bytes(b"tampered")

    with pytest.raises(ObjectIntegrityError, match="failed verification"):
        store.put(BytesIO(payload))


def test_object_manifest_detects_corrupt_and_unexpected_objects(tmp_path: Path) -> None:
    store = ContentAddressedObjectStore(tmp_path / "objects")
    first = store.put(BytesIO(b"SYNTHETIC TEST RECORD - NOT A REAL PATIENT - 1"))
    manifest = build_object_manifest(store)
    manifest_path = tmp_path / "backups" / "objects.json"
    manifest_sha256 = write_manifest_atomic(manifest, manifest_path)

    assert len(manifest_sha256) == 64
    loaded = read_manifest(manifest_path)
    assert verify_object_manifest(store, loaded).ok is True

    first.path.chmod(0o600)
    first.path.write_bytes(b"tampered")
    second = store.put(BytesIO(b"SYNTHETIC TEST RECORD - NOT A REAL PATIENT - 2"))
    report = verify_object_manifest(store, loaded)

    assert report.corrupt == (first.digest,)
    assert report.unexpected == (second.digest,)
    assert report.ok is False
