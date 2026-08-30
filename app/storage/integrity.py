import hashlib
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.storage.objects import ContentAddressedObjectStore

MANIFEST_VERSION = "careledger.objects.v1"


@dataclass(frozen=True)
class ObjectManifestEntry:
    sha256: str
    size: int


@dataclass(frozen=True)
class ObjectManifest:
    version: str
    created_at: str
    entries: tuple[ObjectManifestEntry, ...]


@dataclass(frozen=True)
class IntegrityReport:
    missing: tuple[str, ...]
    corrupt: tuple[str, ...]
    unexpected: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return not (self.missing or self.corrupt or self.unexpected)


def build_object_manifest(store: ContentAddressedObjectStore) -> ObjectManifest:
    entries: list[ObjectManifestEntry] = []
    for digest in store.iter_digests():
        path = store.path_for(digest)
        if not store.verify(digest):
            raise ValueError("object store contains a corrupt source object")
        entries.append(ObjectManifestEntry(sha256=digest, size=path.stat().st_size))
    return ObjectManifest(
        version=MANIFEST_VERSION,
        created_at=datetime.now(UTC).isoformat(),
        entries=tuple(entries),
    )


def verify_object_manifest(
    store: ContentAddressedObjectStore,
    manifest: ObjectManifest,
) -> IntegrityReport:
    if manifest.version != MANIFEST_VERSION:
        raise ValueError("unsupported object manifest version")
    expected = {entry.sha256: entry.size for entry in manifest.entries}
    actual = set(store.iter_digests())
    missing = tuple(sorted(set(expected) - actual))
    unexpected = tuple(sorted(actual - set(expected)))
    corrupt = tuple(
        sorted(
            digest
            for digest, expected_size in expected.items()
            if digest in actual
            and (
                store.path_for(digest).stat().st_size != expected_size or not store.verify(digest)
            )
        )
    )
    return IntegrityReport(missing=missing, corrupt=corrupt, unexpected=unexpected)


def write_manifest_atomic(manifest: ObjectManifest, destination: Path) -> str:
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    document = {
        "version": manifest.version,
        "created_at": manifest.created_at,
        "entries": [asdict(entry) for entry in manifest.entries],
    }
    encoded = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix="objects-", dir=destination.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)
    return hashlib.sha256(encoded).hexdigest()


def read_manifest(path: Path) -> ObjectManifest:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if set(raw) != {"version", "created_at", "entries"}:
        raise ValueError("object manifest has unexpected fields")
    entries = tuple(
        ObjectManifestEntry(sha256=entry["sha256"], size=entry["size"])
        for entry in raw["entries"]
    )
    return ObjectManifest(
        version=raw["version"],
        created_at=raw["created_at"],
        entries=entries,
    )
