import hashlib
import re
from dataclasses import dataclass

from app.ingest.models import MediaType

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class PageContext:
    page_number: int
    text: str | None
    artifact_sha256: str

    def __post_init__(self) -> None:
        if self.page_number < 1:
            raise ValueError("page numbers are one-based")
        if not _SHA256.fullmatch(self.artifact_sha256):
            raise ValueError("page artifact digest must be lowercase SHA-256")


@dataclass(frozen=True)
class SourceBatch:
    batch_token: str
    source_bytes: bytes
    transmitted_bytes: bytes
    media_type: MediaType
    pages: tuple[PageContext, ...]

    def __post_init__(self) -> None:
        if not self.batch_token or len(self.batch_token) > 128:
            raise ValueError("batch token is required")
        if not self.source_bytes or not self.transmitted_bytes:
            raise ValueError("source and transmitted bytes are required")
        if not self.pages:
            raise ValueError("at least one submitted page is required")
        page_numbers = [page.page_number for page in self.pages]
        if len(page_numbers) != len(set(page_numbers)):
            raise ValueError("submitted page numbers must be unique")
        if self.media_type != MediaType.PDF and len(self.pages) != 1:
            raise ValueError("an image batch maps to exactly one original page")

    @property
    def source_sha256(self) -> str:
        return hashlib.sha256(self.source_bytes).hexdigest()

    @property
    def transmitted_sha256(self) -> str:
        return hashlib.sha256(self.transmitted_bytes).hexdigest()
