from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol


class MediaType(StrEnum):
    PDF = "application/pdf"
    JPEG = "image/jpeg"
    PNG = "image/png"


class QuarantineState(StrEnum):
    RECEIVING = "receiving"
    STAGED = "staged"
    SCANNING = "scanning"
    INSPECTING = "inspecting"
    VALIDATED = "validated"
    PROMOTED = "promoted"
    REJECTED = "rejected"
    FAILED_RETRYABLE = "failed_retryable"


class ScanVerdict(StrEnum):
    CLEAN = "clean"
    DETECTED = "detected"
    UNAVAILABLE = "unavailable"
    NOT_CONFIGURED = "not_configured"


class UploadErrorCode(StrEnum):
    EMPTY_UPLOAD = "EMPTY_UPLOAD"
    UPLOAD_TOO_LARGE = "UPLOAD_TOO_LARGE"
    UNSUPPORTED_TYPE = "UNSUPPORTED_TYPE"
    MIME_MISMATCH = "MIME_MISMATCH"
    EXTENSION_MISMATCH = "EXTENSION_MISMATCH"
    MALFORMED_IMAGE = "MALFORMED_IMAGE"
    IMAGE_PIXEL_LIMIT = "IMAGE_PIXEL_LIMIT"
    IMAGE_DIMENSION_LIMIT = "IMAGE_DIMENSION_LIMIT"
    IMAGE_MULTIFRAME = "IMAGE_MULTIFRAME"
    IMAGE_TRAILING_DATA = "IMAGE_TRAILING_DATA"
    MALFORMED_PDF = "MALFORMED_PDF"
    PDF_ENCRYPTED = "PDF_ENCRYPTED"
    PDF_PAGE_LIMIT = "PDF_PAGE_LIMIT"
    PDF_OBJECT_LIMIT = "PDF_OBJECT_LIMIT"
    PDF_PAGE_GEOMETRY = "PDF_PAGE_GEOMETRY"
    PDF_ACTIVE_CONTENT = "PDF_ACTIVE_CONTENT"
    MALWARE_DETECTED = "MALWARE_DETECTED"
    SCAN_UNAVAILABLE = "SCAN_UNAVAILABLE"
    DIGEST_CHANGED = "DIGEST_CHANGED"
    INVALID_STAGE = "INVALID_STAGE"
    STREAM_IO_ERROR = "STREAM_IO_ERROR"


class UploadRejected(Exception):
    def __init__(
        self,
        code: UploadErrorCode,
        user_message: str,
        *,
        retryable: bool = False,
    ) -> None:
        super().__init__(code.value)
        self.code = code
        self.user_message = user_message
        self.retryable = retryable


@dataclass(frozen=True)
class ScanReport:
    verdict: ScanVerdict
    engine: str | None = None


class MalwareScanner(Protocol):
    def scan(self, path: Path) -> ScanReport: ...


@dataclass(frozen=True)
class Inspection:
    page_count: int | None = None
    width: int | None = None
    height: int | None = None


@dataclass(frozen=True)
class StagedUpload:
    stage_id: str
    payload_path: Path
    digest: str
    size: int
    display_name: str
    media_type: MediaType
    inspection: Inspection | None = None
    scan_report: ScanReport | None = None


@dataclass(frozen=True)
class AcceptedSource:
    digest: str
    size: int
    display_name: str
    media_type: MediaType
    already_existed: bool
    page_count: int | None
    width: int | None
    height: int | None
    scan_verdict: ScanVerdict
