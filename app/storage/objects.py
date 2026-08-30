import hashlib
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO


class ObjectIntegrityError(RuntimeError):
    pass


@dataclass(frozen=True)
class StoredObject:
    digest: str
    size: int
    path: Path
    already_existed: bool


class ContentAddressedObjectStore:
    """Stores immutable bytes by SHA-256 digest outside the web root."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)

    def put(self, stream: BinaryIO, *, chunk_size: int = 1024 * 1024) -> StoredObject:
        digest = hashlib.sha256()
        size = 0
        descriptor, temporary_name = tempfile.mkstemp(prefix="incoming-", dir=self._root)
        temporary_path = Path(temporary_name)

        try:
            with os.fdopen(descriptor, "wb") as target:
                while chunk := stream.read(chunk_size):
                    digest.update(chunk)
                    size += len(chunk)
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())

            hexdigest = digest.hexdigest()
            destination = self.path_for(hexdigest)
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

            if destination.exists():
                if not self.verify(hexdigest):
                    raise ObjectIntegrityError(
                        "existing content-addressed object failed verification"
                    )
                temporary_path.unlink(missing_ok=True)
                return StoredObject(hexdigest, size, destination, already_existed=True)

            os.replace(temporary_path, destination)
            destination.chmod(0o400)
            return StoredObject(hexdigest, size, destination, already_existed=False)
        finally:
            temporary_path.unlink(missing_ok=True)

    def open(self, digest: str) -> BinaryIO:
        return self.path_for(digest).open("rb")

    def verify(self, digest: str) -> bool:
        candidate = self.path_for(digest)
        if not candidate.is_file():
            return False
        computed = hashlib.sha256()
        with candidate.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                computed.update(chunk)
        return computed.hexdigest() == digest

    def path_for(self, digest: str) -> Path:
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise ValueError("digest must be a lowercase SHA-256 hexadecimal string")
        return self._root / digest[:2] / digest[2:4] / digest

    def copy_to(self, digest: str, target: BinaryIO) -> None:
        with self.open(digest) as source:
            shutil.copyfileobj(source, target)

    def iter_digests(self) -> tuple[str, ...]:
        digests: list[str] = []
        for candidate in self._root.glob("*/*/*"):
            digest = candidate.name
            try:
                expected = self.path_for(digest)
            except ValueError:
                continue
            if candidate.is_file() and candidate == expected:
                digests.append(digest)
        return tuple(sorted(digests))
