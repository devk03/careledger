import hashlib
import os
from dataclasses import replace
from pathlib import Path
from typing import BinaryIO

from app.ingest.filenames import safe_display_name
from app.ingest.inspectors import inspect_upload
from app.ingest.models import (
    AcceptedSource,
    MalwareScanner,
    QuarantineState,
    ScanVerdict,
    StagedUpload,
    UploadErrorCode,
    UploadRejected,
)
from app.ingest.quarantine import QuarantineManifest, QuarantineStore
from app.ingest.scanners import NoopMalwareScanner
from app.ingest.signatures import detect_media_type, validate_claimed_media_type
from app.storage.objects import ContentAddressedObjectStore


class UploadIntake:
    def __init__(
        self,
        *,
        quarantine_root: Path,
        object_store: ContentAddressedObjectStore,
        scanner: MalwareScanner | None = None,
        require_malware_scan: bool = False,
        max_upload_bytes: int = 30 * 1024 * 1024,
        max_pdf_pages: int = 200,
        max_pdf_objects: int = 100_000,
        max_pdf_page_points: int = 14_400,
        max_image_pixels: int = 40_000_000,
        max_image_dimension: int = 20_000,
        max_filename_bytes: int = 120,
    ) -> None:
        self._quarantine = QuarantineStore(quarantine_root)
        self._objects = object_store
        self._scanner = scanner or NoopMalwareScanner()
        self._require_malware_scan = require_malware_scan
        self._max_upload_bytes = max_upload_bytes
        self._max_pdf_pages = max_pdf_pages
        self._max_pdf_objects = max_pdf_objects
        self._max_pdf_page_points = max_pdf_page_points
        self._max_image_pixels = max_image_pixels
        self._max_image_dimension = max_image_dimension
        self._max_filename_bytes = max_filename_bytes

    def receive(
        self,
        stream: BinaryIO,
        *,
        original_name: str,
        claimed_media_type: str | None,
        content_length: int | None = None,
    ) -> StagedUpload:
        if content_length is not None and content_length > self._max_upload_bytes:
            raise UploadRejected(
                UploadErrorCode.UPLOAD_TOO_LARGE,
                "This file is larger than the upload safety limit.",
            )

        manifest, payload_path = self._quarantine.create()
        try:
            digest, size = self._write_bounded(stream, payload_path)
            detected = detect_media_type(payload_path)
            validate_claimed_media_type(claimed_media_type, detected)
            display_name = safe_display_name(
                original_name,
                detected,
                max_bytes=self._max_filename_bytes,
            )
            manifest = self._quarantine.transition(
                manifest,
                QuarantineState.STAGED,
                digest=digest,
                size=size,
                display_name=display_name,
                media_type=detected.value,
            )
            return StagedUpload(
                stage_id=manifest.stage_id,
                payload_path=payload_path,
                digest=digest,
                size=size,
                display_name=display_name,
                media_type=detected,
            )
        except UploadRejected as error:
            self._reject_if_possible(manifest, error)
            raise
        except OSError as error:
            rejection = UploadRejected(
                UploadErrorCode.STREAM_IO_ERROR,
                "CareLedger could not safely receive this file. Please try again.",
                retryable=True,
            )
            self._reject_if_possible(manifest, rejection)
            raise rejection from error

    def validate(self, staged: StagedUpload) -> StagedUpload:
        manifest = self._manifest_from(staged, QuarantineState.STAGED)
        try:
            manifest = self._quarantine.transition(manifest, QuarantineState.SCANNING)
            scan_report = self._scanner.scan(staged.payload_path)
            if scan_report.verdict == ScanVerdict.DETECTED:
                raise UploadRejected(
                    UploadErrorCode.MALWARE_DETECTED,
                    "This file did not pass the malware safety check.",
                )
            if self._require_malware_scan and scan_report.verdict in {
                ScanVerdict.UNAVAILABLE,
                ScanVerdict.NOT_CONFIGURED,
            }:
                raise UploadRejected(
                    UploadErrorCode.SCAN_UNAVAILABLE,
                    "The file scanner is temporarily unavailable. Please try again later.",
                    retryable=True,
                )

            manifest = self._quarantine.transition(manifest, QuarantineState.INSPECTING)
            self._assert_digest(staged)
            inspection = inspect_upload(
                staged.payload_path,
                staged.media_type,
                max_pdf_pages=self._max_pdf_pages,
                max_pdf_objects=self._max_pdf_objects,
                max_pdf_page_points=self._max_pdf_page_points,
                max_image_pixels=self._max_image_pixels,
                max_image_dimension=self._max_image_dimension,
            )
            self._quarantine.transition(manifest, QuarantineState.VALIDATED)
            return replace(staged, inspection=inspection, scan_report=scan_report)
        except UploadRejected as error:
            self._reject_if_possible(manifest, error)
            raise

    def promote(self, staged: StagedUpload) -> AcceptedSource:
        if staged.inspection is None or staged.scan_report is None:
            raise UploadRejected(
                UploadErrorCode.INVALID_STAGE,
                "This file must pass safety checks before it can be added.",
            )
        manifest = self._manifest_from(staged, QuarantineState.VALIDATED)
        self._assert_digest(staged)
        with staged.payload_path.open("rb") as source:
            stored = self._objects.put(source)
        if stored.digest != staged.digest:
            raise UploadRejected(
                UploadErrorCode.DIGEST_CHANGED,
                "The file changed during processing and was not accepted.",
            )
        self._quarantine.transition(manifest, QuarantineState.PROMOTED)
        return AcceptedSource(
            digest=stored.digest,
            size=stored.size,
            display_name=staged.display_name,
            media_type=staged.media_type,
            already_existed=stored.already_existed,
            page_count=staged.inspection.page_count,
            width=staged.inspection.width,
            height=staged.inspection.height,
            scan_verdict=staged.scan_report.verdict,
        )

    def _write_bounded(self, stream: BinaryIO, path: Path) -> tuple[str, int]:
        digest = hashlib.sha256()
        size = 0
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as target:
                while True:
                    remaining = self._max_upload_bytes - size
                    chunk = stream.read(min(1024 * 1024, remaining + 1))
                    if not chunk:
                        break
                    if len(chunk) > remaining:
                        raise UploadRejected(
                            UploadErrorCode.UPLOAD_TOO_LARGE,
                            "This file is larger than the upload safety limit.",
                        )
                    target.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                if size == 0:
                    raise UploadRejected(
                        UploadErrorCode.EMPTY_UPLOAD,
                        "This file is empty. Please choose the original PDF or image again.",
                    )
                target.flush()
                os.fsync(target.fileno())
            path.chmod(0o400)
            return digest.hexdigest(), size
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    def _assert_digest(self, staged: StagedUpload) -> None:
        digest = hashlib.sha256()
        with staged.payload_path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        if digest.hexdigest() != staged.digest:
            raise UploadRejected(
                UploadErrorCode.DIGEST_CHANGED,
                "The file changed during processing and was not accepted.",
            )

    def _manifest_from(
        self,
        staged: StagedUpload,
        state: QuarantineState,
    ) -> QuarantineManifest:
        manifest = self._quarantine.read(staged.stage_id)
        if manifest.state != state:
            raise UploadRejected(
                UploadErrorCode.INVALID_STAGE,
                "This upload cannot continue from its current safety-check state.",
            )
        if (
            manifest.digest != staged.digest
            or manifest.size != staged.size
            or manifest.media_type != staged.media_type.value
        ):
            raise UploadRejected(
                UploadErrorCode.DIGEST_CHANGED,
                "The file changed during processing and was not accepted.",
            )
        return manifest

    def _reject_if_possible(
        self,
        manifest: QuarantineManifest,
        error: UploadRejected,
    ) -> None:
        target = (
            QuarantineState.FAILED_RETRYABLE if error.retryable else QuarantineState.REJECTED
        )
        if target in _safe_allowed_targets(manifest.state):
            self._quarantine.transition(manifest, target, failure_code=error.code.value)


def _safe_allowed_targets(state: QuarantineState) -> set[QuarantineState]:
    if state in {QuarantineState.PROMOTED, QuarantineState.REJECTED}:
        return set()
    return {QuarantineState.REJECTED, QuarantineState.FAILED_RETRYABLE}
