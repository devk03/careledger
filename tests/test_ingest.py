import json
from io import BytesIO
from pathlib import Path

import pikepdf
import pytest
from PIL import Image, ImageDraw

from app.ingest.filenames import safe_display_name
from app.ingest.models import (
    MediaType,
    ScanReport,
    ScanVerdict,
    UploadErrorCode,
    UploadRejected,
)
from app.ingest.pipeline import UploadIntake
from app.storage.objects import ContentAddressedObjectStore

SYNTHETIC_LABEL = "SYNTHETIC TEST RECORD - NOT A REAL PATIENT"


class CleanScanner:
    def scan(self, path: Path) -> ScanReport:
        assert path.is_file()
        return ScanReport(verdict=ScanVerdict.CLEAN, engine="synthetic-test-scanner")


def _intake(
    tmp_path: Path,
    *,
    max_upload_bytes: int = 30 * 1024 * 1024,
    max_pdf_pages: int = 200,
) -> UploadIntake:
    return UploadIntake(
        quarantine_root=tmp_path / "quarantine",
        object_store=ContentAddressedObjectStore(tmp_path / "objects"),
        scanner=CleanScanner(),
        require_malware_scan=True,
        max_upload_bytes=max_upload_bytes,
        max_pdf_pages=max_pdf_pages,
    )


def _image_bytes(image_format: str) -> bytes:
    image = Image.new("RGB", (640, 240), color=(248, 243, 236))
    ImageDraw.Draw(image).text((24, 96), SYNTHETIC_LABEL, fill=(32, 32, 32))
    output = BytesIO()
    image.save(output, format=image_format)
    return output.getvalue()


def _pdf_bytes(*, active: bool = False, encrypted: bool = False, pages: int = 1) -> bytes:
    output = BytesIO()
    with pikepdf.Pdf.new() as pdf:
        font = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name("/Font"),
                Subtype=pikepdf.Name("/Type1"),
                BaseFont=pikepdf.Name("/Helvetica"),
            )
        )
        for _ in range(pages):
            page = pdf.add_blank_page()
            page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
            page.Contents = pikepdf.Stream(
                pdf,
                f"BT /F1 11 Tf 36 720 Td ({SYNTHETIC_LABEL}) Tj ET".encode(),
            )
        if active:
            pdf.Root.OpenAction = pikepdf.Dictionary(
                S=pikepdf.Name("/JavaScript"),
                JS="app.alert('synthetic')",
            )
        encryption = (
            pikepdf.Encryption(owner="synthetic-owner", user="synthetic-user")
            if encrypted
            else False
        )
        pdf.save(output, encryption=encryption)
    return output.getvalue()


@pytest.mark.parametrize(
    ("image_format", "media_type", "filename"),
    [
        ("PNG", MediaType.PNG, "synthetic-record.png"),
        ("JPEG", MediaType.JPEG, "synthetic-record.jpeg"),
    ],
)
def test_valid_image_is_validated_and_promoted(
    tmp_path: Path,
    image_format: str,
    media_type: MediaType,
    filename: str,
) -> None:
    intake = _intake(tmp_path)
    payload = _image_bytes(image_format)

    staged = intake.receive(
        BytesIO(payload),
        original_name=filename,
        claimed_media_type=media_type.value,
    )
    validated = intake.validate(staged)
    accepted = intake.promote(validated)

    assert accepted.media_type == media_type
    assert accepted.width == 640
    assert accepted.height == 240
    assert accepted.scan_verdict == ScanVerdict.CLEAN
    assert accepted.already_existed is False
    object_path = (
        tmp_path / "objects" / accepted.digest[:2] / accepted.digest[2:4] / accepted.digest
    )
    assert object_path.is_file()
    manifest = json.loads(
        (tmp_path / "quarantine" / staged.stage_id / "manifest.json").read_text()
    )
    assert manifest["state"] == "promoted"


def test_valid_pdf_tracks_page_count_and_deduplicates(tmp_path: Path) -> None:
    intake = _intake(tmp_path)
    payload = _pdf_bytes(pages=2)

    first = intake.promote(
        intake.validate(
            intake.receive(
                BytesIO(payload),
                original_name="synthetic-record.pdf",
                claimed_media_type="application/pdf",
            )
        )
    )
    second = intake.promote(
        intake.validate(
            intake.receive(
                BytesIO(payload),
                original_name="synthetic-copy.pdf",
                claimed_media_type="application/pdf",
            )
        )
    )

    assert first.page_count == 2
    assert first.digest == second.digest
    assert second.already_existed is True


def test_receive_rejects_size_mime_and_extension_spoofing(tmp_path: Path) -> None:
    payload = _image_bytes("PNG")
    intake = _intake(tmp_path, max_upload_bytes=len(payload) - 1)
    with pytest.raises(UploadRejected) as too_large:
        intake.receive(
            BytesIO(payload),
            original_name="synthetic.png",
            claimed_media_type=MediaType.PNG.value,
        )
    assert too_large.value.code == UploadErrorCode.UPLOAD_TOO_LARGE

    intake = _intake(tmp_path / "mime")
    with pytest.raises(UploadRejected) as wrong_mime:
        intake.receive(
            BytesIO(payload),
            original_name="synthetic.png",
            claimed_media_type=MediaType.JPEG.value,
        )
    assert wrong_mime.value.code == UploadErrorCode.MIME_MISMATCH

    with pytest.raises(UploadRejected) as wrong_extension:
        intake.receive(
            BytesIO(payload),
            original_name="synthetic.pdf",
            claimed_media_type=MediaType.PNG.value,
        )
    assert wrong_extension.value.code == UploadErrorCode.EXTENSION_MISMATCH


def test_pdf_active_content_encryption_and_page_limit_fail_closed(tmp_path: Path) -> None:
    cases = [
        (_pdf_bytes(active=True), UploadErrorCode.PDF_ACTIVE_CONTENT, {}),
        (_pdf_bytes(encrypted=True), UploadErrorCode.PDF_ENCRYPTED, {}),
        (_pdf_bytes(pages=2), UploadErrorCode.PDF_PAGE_LIMIT, {"max_pdf_pages": 1}),
    ]
    for index, (payload, expected_code, overrides) in enumerate(cases):
        intake = _intake(tmp_path / str(index), **overrides)
        staged = intake.receive(
            BytesIO(payload),
            original_name="synthetic-record.pdf",
            claimed_media_type=MediaType.PDF.value,
        )
        with pytest.raises(UploadRejected) as rejected:
            intake.validate(staged)
        assert rejected.value.code == expected_code


def test_digest_rechecked_before_promotion(tmp_path: Path) -> None:
    intake = _intake(tmp_path)
    staged = intake.receive(
        BytesIO(_image_bytes("PNG")),
        original_name="synthetic.png",
        claimed_media_type=MediaType.PNG.value,
    )
    validated = intake.validate(staged)
    staged.payload_path.chmod(0o600)
    staged.payload_path.write_bytes(b"changed after validation")

    with pytest.raises(UploadRejected) as rejected:
        intake.promote(validated)
    assert rejected.value.code == UploadErrorCode.DIGEST_CHANGED


def test_filename_is_display_only_normalized_and_bounded() -> None:
    result = safe_display_name(
        "../../private\\..\\\u202esecret  report  .PNG",
        MediaType.PNG,
        max_bytes=48,
    )
    assert result == "secret report.png"
    assert "/" not in result
    assert "\\" not in result
    assert len(result.encode()) <= 48
