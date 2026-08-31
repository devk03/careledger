import hashlib
import os
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


@dataclass(frozen=True)
class BootstrapState:
    setup_required: bool
    token_created: bool
    setup_url: str | None


class BootstrapManager:
    """Creates a one-time setup secret without putting it in source or environment files."""

    def __init__(
        self,
        secrets_dir: Path,
        public_base_url: str,
        *,
        token_ttl_seconds: int = 60 * 60,
    ) -> None:
        self._secrets_dir = secrets_dir
        self._public_base_url = public_base_url.rstrip("/")
        self._token_ttl_seconds = token_ttl_seconds
        self._token_path = secrets_dir / "bootstrap-token"
        self._token_hash_path = secrets_dir / "bootstrap-token.sha256"
        self._completed_path = secrets_dir / "bootstrap.completed"

    def initialize(self, *, setup_complete: bool | None = None) -> BootstrapState:
        self._secrets_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

        completed = self._completed_path.exists() if setup_complete is None else setup_complete
        if completed:
            return BootstrapState(setup_required=False, token_created=False, setup_url=None)

        if (
            self._token_hash_path.exists()
            and self._token_path.exists()
            and not self._is_expired()
        ):
            token = self._token_path.read_text(encoding="utf-8").strip()
            return BootstrapState(
                setup_required=True,
                token_created=False,
                setup_url=f"{self._public_base_url}/setup#token={token}",
            )

        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        self._write_private(self._token_path, token, replace=self._token_path.exists())
        self._write_private(
            self._token_hash_path,
            token_hash,
            replace=self._token_hash_path.exists(),
        )
        return BootstrapState(
            setup_required=True,
            token_created=True,
            setup_url=f"{self._public_base_url}/setup#token={token}",
        )

    def verify(self, token: str, *, setup_complete: bool | None = None) -> bool:
        completed = self._completed_path.exists() if setup_complete is None else setup_complete
        if (
            completed
            or not self._token_hash_path.exists()
            or not self._token_path.exists()
            or self._is_expired()
        ):
            return False
        expected = self._token_hash_path.read_text(encoding="utf-8").strip()
        actual = hashlib.sha256(token.encode("utf-8")).hexdigest()
        return secrets.compare_digest(expected, actual)

    def complete(self, token: str, *, setup_complete: bool | None = None) -> bool:
        if not self.verify(token, setup_complete=setup_complete):
            return False
        try:
            self._write_private(
                self._completed_path,
                datetime.now(UTC).isoformat(),
            )
        except FileExistsError:
            return False
        return True

    def _is_expired(self) -> bool:
        try:
            age = time.time() - self._token_path.stat().st_mtime
        except OSError:
            return True
        return age >= self._token_ttl_seconds

    @staticmethod
    def _write_private(path: Path, value: str, *, replace: bool = False) -> None:
        flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if replace else os.O_EXCL)
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
