import json
import os
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.ingest.models import QuarantineState, UploadErrorCode, UploadRejected


@dataclass(frozen=True)
class QuarantineManifest:
    stage_id: str
    state: QuarantineState
    created_at: str
    updated_at: str
    digest: str | None = None
    size: int | None = None
    display_name: str | None = None
    media_type: str | None = None
    failure_code: str | None = None


class QuarantineStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)

    def create(self) -> tuple[QuarantineManifest, Path]:
        stage_id = uuid4().hex
        stage_dir = self.root / stage_id
        stage_dir.mkdir(mode=0o700)
        now = datetime.now(UTC).isoformat()
        manifest = QuarantineManifest(
            stage_id=stage_id,
            state=QuarantineState.RECEIVING,
            created_at=now,
            updated_at=now,
        )
        self.write(manifest)
        return manifest, stage_dir / "payload"

    def transition(
        self,
        manifest: QuarantineManifest,
        state: QuarantineState,
        **changes: str | int | None,
    ) -> QuarantineManifest:
        allowed = _ALLOWED_TRANSITIONS[manifest.state]
        if state not in allowed:
            raise UploadRejected(
                UploadErrorCode.INVALID_STAGE,
                "This upload cannot continue from its current safety-check state.",
            )
        values = asdict(manifest)
        values.update(changes)
        values["state"] = state
        values["updated_at"] = datetime.now(UTC).isoformat()
        updated = QuarantineManifest(**values)
        self.write(updated)
        return updated

    def read(self, stage_id: str) -> QuarantineManifest:
        manifest_path = self._stage_dir(stage_id) / "manifest.json"
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
            raw["state"] = QuarantineState(raw["state"])
            return QuarantineManifest(**raw)
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            raise UploadRejected(
                UploadErrorCode.INVALID_STAGE,
                "This upload reference is invalid or incomplete.",
            ) from error

    def write(self, manifest: QuarantineManifest) -> None:
        stage_dir = self._stage_dir(manifest.stage_id)
        stage_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        serialized = asdict(manifest)
        serialized["state"] = manifest.state.value
        descriptor, temporary_name = tempfile.mkstemp(prefix="manifest-", dir=stage_dir)
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(serialized, handle, separators=(",", ":"), sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_path, 0o600)
            os.replace(temporary_path, stage_dir / "manifest.json")
        finally:
            temporary_path.unlink(missing_ok=True)

    def _stage_dir(self, stage_id: str) -> Path:
        if len(stage_id) != 32 or any(
            character not in "0123456789abcdef" for character in stage_id
        ):
            raise UploadRejected(
                UploadErrorCode.INVALID_STAGE,
                "This upload reference is invalid.",
            )
        return self.root / stage_id


_ALLOWED_TRANSITIONS: dict[QuarantineState, set[QuarantineState]] = {
    QuarantineState.RECEIVING: {
        QuarantineState.STAGED,
        QuarantineState.REJECTED,
        QuarantineState.FAILED_RETRYABLE,
    },
    QuarantineState.STAGED: {
        QuarantineState.SCANNING,
        QuarantineState.REJECTED,
        QuarantineState.FAILED_RETRYABLE,
    },
    QuarantineState.SCANNING: {
        QuarantineState.INSPECTING,
        QuarantineState.REJECTED,
        QuarantineState.FAILED_RETRYABLE,
    },
    QuarantineState.INSPECTING: {
        QuarantineState.VALIDATED,
        QuarantineState.REJECTED,
        QuarantineState.FAILED_RETRYABLE,
    },
    QuarantineState.VALIDATED: {
        QuarantineState.PROMOTED,
        QuarantineState.REJECTED,
        QuarantineState.FAILED_RETRYABLE,
    },
    QuarantineState.PROMOTED: set(),
    QuarantineState.REJECTED: set(),
    QuarantineState.FAILED_RETRYABLE: {QuarantineState.SCANNING},
}
