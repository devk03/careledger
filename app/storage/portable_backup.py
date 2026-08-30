import hashlib
import hmac
import io
import json
import os
import shutil
import struct
import tarfile
import tempfile
import unicodedata
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import IO, Any, BinaryIO, cast
from uuid import UUID, uuid4

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.storage.integrity import (
    MANIFEST_VERSION,
    ObjectManifest,
    ObjectManifestEntry,
    verify_object_manifest,
)
from app.storage.objects import ContentAddressedObjectStore
from app.storage.sqlite_snapshot import verify_sqlite_snapshot

BACKUP_FORMAT = "careledger.portable.v1"
_MAGIC = b"CARELEDGER-BKP01"
_HEADER = struct.Struct(">16sBBBBI16s8s16s")
_RECORD_HEADER = struct.Struct(">BII")
_FOOTER = struct.Struct(">IQ32s")
_VERSION = 1
_KDF_PROFILE = 1
_CIPHER_ID = 1
_CHUNK_SIZE = 1024 * 1024
_SALT_SIZE = 16
_NONCE_PREFIX_SIZE = 8
_TAG_SIZE = 16
_MANIFEST_PATH = "backup-manifest.json"
_DATABASE_PATH = "database/app.sqlite"
_MAX_MANIFEST_BYTES = 1024 * 1024
_MAX_MEMBERS = 100_000
_MAX_TOTAL_BYTES = 50 * 1024 * 1024 * 1024


class BackupErrorCode(StrEnum):
    INVALID_PASSPHRASE = "INVALID_PASSPHRASE"  # noqa: S105 - typed failure code
    INVALID_HEADER = "INVALID_HEADER"
    CRYPTO_FAILURE = "CRYPTO_FAILURE"
    INVALID_ARCHIVE = "INVALID_ARCHIVE"
    INTEGRITY_FAILURE = "INTEGRITY_FAILURE"
    DESTINATION_NOT_EMPTY = "DESTINATION_NOT_EMPTY"
    UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"


class BackupRejected(Exception):
    def __init__(self, code: BackupErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class BackupMember:
    path: str
    kind: str
    sha256: str
    size: int


@dataclass(frozen=True)
class PortableManifest:
    format: str
    created_at: str
    app_version: str
    schema_version: int
    object_manifest_version: str
    members: tuple[BackupMember, ...]


@dataclass(frozen=True)
class BackupReceipt:
    export_id: UUID
    encrypted_size: int
    object_count: int
    includes_database: bool


@dataclass(frozen=True)
class RestoreReceipt:
    export_id: UUID
    destination: Path
    object_count: int
    database_path: Path | None


@dataclass(frozen=True)
class _ParsedHeader:
    raw: bytes
    salt: bytes
    nonce_prefix: bytes
    export_id: UUID


def export_portable_backup(
    store: ContentAddressedObjectStore,
    destination: Path,
    passphrase: str,
    *,
    database_snapshot: Path | None = None,
    app_version: str = "0.1.0",
    schema_version: int = 0,
    created_at: datetime | None = None,
) -> BackupReceipt:
    if destination.exists():
        raise ValueError("backup destination already exists")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    object_entries = _verified_object_entries(store)
    members = [
        BackupMember(
            path=_object_member_path(entry.sha256),
            kind="source_object",
            sha256=entry.sha256,
            size=entry.size,
        )
        for entry in object_entries
    ]
    if database_snapshot is not None:
        if not database_snapshot.is_file() or database_snapshot.is_symlink():
            raise ValueError("database snapshot must be a regular file")
        verify_sqlite_snapshot(database_snapshot)
        members.append(
            BackupMember(
                path=_DATABASE_PATH,
                kind="sqlite_snapshot",
                sha256=_file_sha256(database_snapshot),
                size=database_snapshot.stat().st_size,
            )
        )
    members.sort(key=lambda member: member.path)
    manifest = PortableManifest(
        format=BACKUP_FORMAT,
        created_at=(created_at or datetime.now(UTC)).isoformat(),
        app_version=app_version,
        schema_version=schema_version,
        object_manifest_version=MANIFEST_VERSION,
        members=tuple(members),
    )
    manifest_bytes = _manifest_bytes(manifest)
    export_id = uuid4()
    descriptor, temporary_name = tempfile.mkstemp(prefix=".backup-", dir=destination.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as encrypted:
            writer = _EncryptedChunkWriter(encrypted, passphrase, export_id=export_id)
            with tarfile.open(
                fileobj=cast(BinaryIO, writer),
                mode="w|",
                format=tarfile.USTAR_FORMAT,
            ) as archive:
                _add_bytes(archive, _MANIFEST_PATH, manifest_bytes)
                if database_snapshot is not None:
                    _add_file(archive, _DATABASE_PATH, database_snapshot)
                for entry in object_entries:
                    _add_file(
                        archive,
                        _object_member_path(entry.sha256),
                        store.path_for(entry.sha256),
                    )
            writer.finalize()
            encrypted.flush()
            os.fsync(encrypted.fileno())
        temporary_path.chmod(0o600)
        inspect_portable_backup(temporary_path, passphrase)
        os.replace(temporary_path, destination)
        destination.chmod(0o600)
        _fsync_directory(destination.parent)
    finally:
        temporary_path.unlink(missing_ok=True)
    return BackupReceipt(
        export_id=export_id,
        encrypted_size=destination.stat().st_size,
        object_count=len(object_entries),
        includes_database=database_snapshot is not None,
    )


def inspect_portable_backup(path: Path, passphrase: str) -> PortableManifest:
    with path.open("rb") as encrypted:
        reader = _EncryptedChunkReader(encrypted, passphrase)
        manifest = _read_archive(reader, destination=None)
        reader.verify_footer()
        return manifest


def restore_portable_backup(
    path: Path,
    destination: Path,
    passphrase: str,
) -> RestoreReceipt:
    if destination.exists():
        raise BackupRejected(BackupErrorCode.DESTINATION_NOT_EMPTY)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}-restore-", dir=destination.parent))
    staging.chmod(0o700)
    try:
        with path.open("rb") as encrypted:
            reader = _EncryptedChunkReader(encrypted, passphrase)
            manifest = _read_archive(reader, destination=staging)
            reader.verify_footer()
            export_id = reader.export_id
        object_entries = tuple(
            ObjectManifestEntry(sha256=member.sha256, size=member.size)
            for member in manifest.members
            if member.kind == "source_object"
        )
        object_store = ContentAddressedObjectStore(staging / "objects" / "sha256")
        report = verify_object_manifest(
            object_store,
            ObjectManifest(
                version=manifest.object_manifest_version,
                created_at=manifest.created_at,
                entries=object_entries,
            ),
        )
        if not report.ok:
            raise BackupRejected(BackupErrorCode.INTEGRITY_FAILURE)
        database_candidate = staging / _DATABASE_PATH
        database_path: Path | None = database_candidate if database_candidate.exists() else None
        if database_path is not None:
            verify_sqlite_snapshot(database_path)
        _write_private(staging / _MANIFEST_PATH, _manifest_bytes(manifest))
        _fsync_directory(staging)
        os.replace(staging, destination)
        _fsync_directory(destination.parent)
        return RestoreReceipt(
            export_id=export_id,
            destination=destination,
            object_count=len(object_entries),
            database_path=(destination / _DATABASE_PATH if database_path is not None else None),
        )
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


class _EncryptedChunkWriter:
    def __init__(self, target: BinaryIO, passphrase: str, *, export_id: UUID) -> None:
        salt = os.urandom(_SALT_SIZE)
        nonce_prefix = os.urandom(_NONCE_PREFIX_SIZE)
        self._header = _HEADER.pack(
            _MAGIC,
            _VERSION,
            _KDF_PROFILE,
            _CIPHER_ID,
            0,
            _CHUNK_SIZE,
            salt,
            nonce_prefix,
            export_id.bytes,
        )
        target.write(self._header)
        self._target = target
        self._cipher = AESGCM(_derive_key(passphrase, salt))
        self._nonce_prefix = nonce_prefix
        self._buffer = bytearray()
        self._index = 0
        self._total = 0
        self._digest = hashlib.sha256()
        self._finalized = False

    def write(self, data: bytes | bytearray) -> int:
        if self._finalized:
            raise ValueError("encrypted backup writer is finalized")
        incoming = bytes(data)
        self._buffer.extend(incoming)
        while len(self._buffer) >= _CHUNK_SIZE:
            chunk = bytes(self._buffer[:_CHUNK_SIZE])
            del self._buffer[:_CHUNK_SIZE]
            self._write_record(1, chunk)
        return len(incoming)

    def tell(self) -> int:
        return self._total + len(self._buffer)

    def flush(self) -> None:
        return None

    def finalize(self) -> None:
        if self._finalized:
            return
        if self._buffer:
            self._write_record(1, bytes(self._buffer))
            self._buffer.clear()
        footer = _FOOTER.pack(self._index, self._total, self._digest.digest())
        self._write_record(2, footer, include_in_digest=False)
        self._finalized = True

    def _write_record(
        self,
        record_type: int,
        plaintext: bytes,
        *,
        include_in_digest: bool = True,
    ) -> None:
        record_header = _RECORD_HEADER.pack(record_type, self._index, len(plaintext))
        nonce = self._nonce_prefix + self._index.to_bytes(4, "big")
        ciphertext = self._cipher.encrypt(
            nonce,
            plaintext,
            _record_aad(self._header, record_header),
        )
        self._target.write(record_header)
        self._target.write(ciphertext)
        if include_in_digest:
            self._digest.update(plaintext)
            self._total += len(plaintext)
        self._index += 1


class _EncryptedChunkReader:
    def __init__(self, source: BinaryIO, passphrase: str) -> None:
        self._source = source
        parsed = _read_header(source)
        self._header = parsed.raw
        self.export_id = parsed.export_id
        self._cipher = AESGCM(_derive_key(passphrase, parsed.salt))
        self._nonce_prefix = parsed.nonce_prefix
        self._expected_index = 0
        self._total = 0
        self._digest = hashlib.sha256()
        self._buffer = bytearray()
        self._footer_verified = False

    def read(self, size: int = -1) -> bytes:
        if size == 0:
            return b""
        if size < 0:
            output = bytearray()
            while chunk := self.read(_CHUNK_SIZE):
                output.extend(chunk)
            return bytes(output)
        while len(self._buffer) < size and not self._footer_verified:
            self._read_record()
        result = bytes(self._buffer[:size])
        del self._buffer[:size]
        return result

    def tell(self) -> int:
        return self._total - len(self._buffer)

    def verify_footer(self) -> None:
        while not self._footer_verified:
            self._read_record()
        if self._buffer:
            raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)

    def _read_record(self) -> None:
        record_header = _read_exact(self._source, _RECORD_HEADER.size)
        record_type, index, plaintext_size = _RECORD_HEADER.unpack(record_header)
        if index != self._expected_index:
            raise BackupRejected(BackupErrorCode.CRYPTO_FAILURE)
        if record_type == 1:
            if plaintext_size < 1 or plaintext_size > _CHUNK_SIZE:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
        elif record_type == 2:
            if plaintext_size != _FOOTER.size:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
        else:
            raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
        encrypted = _read_exact(self._source, plaintext_size + _TAG_SIZE)
        nonce = self._nonce_prefix + index.to_bytes(4, "big")
        try:
            plaintext = self._cipher.decrypt(
                nonce,
                encrypted,
                _record_aad(self._header, record_header),
            )
        except InvalidTag as error:
            raise BackupRejected(BackupErrorCode.CRYPTO_FAILURE) from error
        if record_type == 1:
            self._buffer.extend(plaintext)
            self._digest.update(plaintext)
            self._total += len(plaintext)
            if self._total > _MAX_TOTAL_BYTES + 32 * 1024 * 1024:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
        else:
            chunk_count, total, digest = _FOOTER.unpack(plaintext)
            if (
                chunk_count != self._expected_index
                or total != self._total
                or not hmac.compare_digest(digest, self._digest.digest())
                or self._source.read(1) != b""
            ):
                raise BackupRejected(BackupErrorCode.CRYPTO_FAILURE)
            self._footer_verified = True
        self._expected_index += 1


def _read_archive(
    reader: _EncryptedChunkReader,
    *,
    destination: Path | None,
) -> PortableManifest:
    try:
        with tarfile.open(
            fileobj=cast(BinaryIO, reader),
            mode="r|",
            errorlevel=2,
        ) as archive:
            first = archive.next()
            if first is None or first.name != _MANIFEST_PATH:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
            _validate_tar_member(first)
            if first.size > _MAX_MANIFEST_BYTES:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
            first_stream = archive.extractfile(first)
            if first_stream is None:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
            manifest = _parse_manifest(first_stream.read())
            expected = {member.path: member for member in manifest.members}
            if len(expected) != len(manifest.members) or len(expected) > _MAX_MEMBERS:
                raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
            seen: set[str] = set()
            total = 0
            while (tar_member := archive.next()) is not None:
                _validate_tar_member(tar_member)
                if tar_member.name in seen or tar_member.name not in expected:
                    raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
                seen.add(tar_member.name)
                expected_member = expected[tar_member.name]
                if tar_member.size != expected_member.size:
                    raise BackupRejected(BackupErrorCode.INTEGRITY_FAILURE)
                total += tar_member.size
                if total > _MAX_TOTAL_BYTES:
                    raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
                member_stream = archive.extractfile(tar_member)
                if member_stream is None:
                    raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
                if destination is None:
                    digest, size = _hash_stream(member_stream)
                else:
                    target = destination / PurePosixPath(tar_member.name)
                    digest, size = _write_member(member_stream, target)
                    if expected_member.kind == "source_object":
                        target.chmod(0o400)
                if digest != expected_member.sha256 or size != expected_member.size:
                    raise BackupRejected(BackupErrorCode.INTEGRITY_FAILURE)
            if seen != set(expected):
                raise BackupRejected(BackupErrorCode.INTEGRITY_FAILURE)
            return manifest
    except BackupRejected:
        raise
    except (tarfile.TarError, OSError, EOFError, ValueError) as error:
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE) from error


def _parse_manifest(encoded: bytes) -> PortableManifest:
    try:
        raw = json.loads(encoded, object_pairs_hook=_reject_duplicate_json_keys)
        if not isinstance(raw, dict):
            raise ValueError("manifest root must be an object")
        if set(raw) != {
            "format",
            "created_at",
            "app_version",
            "schema_version",
            "object_manifest_version",
            "members",
        }:
            raise ValueError("unexpected manifest keys")
        if raw["format"] != BACKUP_FORMAT or raw["object_manifest_version"] != MANIFEST_VERSION:
            raise BackupRejected(BackupErrorCode.UNSUPPORTED_FORMAT)
        if (
            not isinstance(raw["created_at"], str)
            or not isinstance(raw["app_version"], str)
            or not raw["app_version"]
            or len(raw["app_version"]) > 64
        ):
            raise ValueError("invalid manifest metadata")
        datetime.fromisoformat(raw["created_at"])
        if (
            not isinstance(raw["schema_version"], int)
            or isinstance(raw["schema_version"], bool)
            or not 0 <= raw["schema_version"] <= 1_000_000
            or not isinstance(raw["members"], list)
        ):
            raise ValueError("invalid manifest schema metadata")
        members = tuple(_parse_member(value) for value in raw["members"])
        return PortableManifest(
            format=raw["format"],
            created_at=raw["created_at"],
            app_version=raw["app_version"],
            schema_version=raw["schema_version"],
            object_manifest_version=raw["object_manifest_version"],
            members=members,
        )
    except BackupRejected:
        raise
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE) from error


def _parse_member(raw: Any) -> BackupMember:
    if not isinstance(raw, dict) or set(raw) != {"path", "kind", "sha256", "size"}:
        raise ValueError("invalid manifest member")
    path = raw["path"]
    kind = raw["kind"]
    digest = raw["sha256"]
    size = raw["size"]
    if not isinstance(path, str) or not isinstance(kind, str):
        raise ValueError("invalid manifest member text")
    validate_backup_member_path(path)
    if kind not in {"source_object", "sqlite_snapshot"}:
        raise ValueError("invalid manifest member kind")
    if not isinstance(digest, str) or len(digest) != 64 or any(
        character not in "0123456789abcdef" for character in digest
    ):
        raise ValueError("invalid manifest digest")
    if (
        not isinstance(size, int)
        or isinstance(size, bool)
        or size < 0
        or size > _MAX_TOTAL_BYTES
    ):
        raise ValueError("invalid manifest size")
    if kind == "source_object" and path != _object_member_path(digest):
        raise ValueError("object path does not match digest")
    if kind == "sqlite_snapshot" and path != _DATABASE_PATH:
        raise ValueError("invalid database snapshot path")
    return BackupMember(path=path, kind=kind, sha256=digest, size=size)


def validate_backup_member_path(value: str) -> PurePosixPath:
    if not value or "\\" in value or "\x00" in value:
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
    raw_parts = value.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
    path = PurePosixPath(value)
    if path.is_absolute():
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
    if len(value.encode("utf-8")) > 240 or ":" in path.parts[0]:
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)
    return path


def _validate_tar_member(member: tarfile.TarInfo) -> None:
    validate_backup_member_path(member.name)
    if not member.isreg() or member.pax_headers or member.size < 0:
        raise BackupRejected(BackupErrorCode.INVALID_ARCHIVE)


def _verified_object_entries(
    store: ContentAddressedObjectStore,
) -> tuple[ObjectManifestEntry, ...]:
    entries: list[ObjectManifestEntry] = []
    for digest in store.iter_digests():
        path = store.path_for(digest)
        if not store.verify(digest):
            raise BackupRejected(BackupErrorCode.INTEGRITY_FAILURE)
        entries.append(ObjectManifestEntry(sha256=digest, size=path.stat().st_size))
    return tuple(entries)


def _manifest_bytes(manifest: PortableManifest) -> bytes:
    document = asdict(manifest)
    return json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _add_bytes(archive: tarfile.TarFile, path: str, content: bytes) -> None:
    info = _tar_info(path, len(content))
    archive.addfile(info, io.BytesIO(content))


def _add_file(archive: tarfile.TarFile, path: str, source: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise BackupRejected(BackupErrorCode.INTEGRITY_FAILURE)
    info = _tar_info(path, source.stat().st_size)
    with source.open("rb") as handle:
        archive.addfile(info, handle)


def _tar_info(path: str, size: int) -> tarfile.TarInfo:
    validate_backup_member_path(path)
    info = tarfile.TarInfo(path)
    info.size = size
    info.mode = 0o600
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.type = tarfile.REGTYPE
    return info


def _read_header(source: BinaryIO) -> _ParsedHeader:
    raw = _read_exact(source, _HEADER.size)
    magic, version, kdf, cipher, reserved, chunk_size, salt, nonce_prefix, export_id = (
        _HEADER.unpack(raw)
    )
    if magic != _MAGIC:
        raise BackupRejected(BackupErrorCode.INVALID_HEADER)
    if (
        version != _VERSION
        or kdf != _KDF_PROFILE
        or cipher != _CIPHER_ID
        or reserved != 0
        or chunk_size != _CHUNK_SIZE
    ):
        raise BackupRejected(BackupErrorCode.UNSUPPORTED_FORMAT)
    return _ParsedHeader(
        raw=raw,
        salt=salt,
        nonce_prefix=nonce_prefix,
        export_id=UUID(bytes=export_id),
    )


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    normalized = unicodedata.normalize("NFC", passphrase)
    if not 12 <= len(normalized) <= 1024 or "\x00" in normalized:
        raise BackupRejected(BackupErrorCode.INVALID_PASSPHRASE)
    return hash_secret_raw(
        secret=normalized.encode("utf-8"),
        salt=salt,
        time_cost=3,
        memory_cost=64 * 1024,
        parallelism=1,
        hash_len=32,
        type=Type.ID,
        version=19,
    )


def _record_aad(header: bytes, record_header: bytes) -> bytes:
    return b"careledger.portable.v1\x00" + header + record_header


def _read_exact(source: BinaryIO, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        chunk = source.read(size - len(result))
        if not chunk:
            raise BackupRejected(BackupErrorCode.CRYPTO_FAILURE)
        result.extend(chunk)
    return bytes(result)


def _write_member(source: IO[bytes], destination: Path) -> tuple[str, int]:
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    digest = hashlib.sha256()
    size = 0
    with os.fdopen(descriptor, "wb") as target:
        while chunk := source.read(1024 * 1024):
            target.write(chunk)
            digest.update(chunk)
            size += len(chunk)
        target.flush()
        os.fsync(target.fileno())
    return digest.hexdigest(), size


def _hash_stream(source: IO[bytes]) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(1024 * 1024):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def _file_sha256(path: Path) -> str:
    with path.open("rb") as source:
        return _hash_stream(source)[0]


def _write_private(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def _object_member_path(digest: str) -> str:
    return f"objects/sha256/{digest[:2]}/{digest[2:4]}/{digest}"


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
