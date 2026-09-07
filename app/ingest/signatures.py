from pathlib import Path

from app.ingest.models import MediaType, UploadErrorCode, UploadRejected

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def detect_media_type(path: Path) -> MediaType:
    with path.open("rb") as handle:
        header = handle.read(16)
    if header.startswith(b"%PDF-"):
        return MediaType.PDF
    if header.startswith(_PNG_SIGNATURE):
        return MediaType.PNG
    if header.startswith(b"\xff\xd8\xff"):
        return MediaType.JPEG
    raise UploadRejected(
        UploadErrorCode.UNSUPPORTED_TYPE,
        "Adeno accepts PDF, JPEG, and PNG records only.",
    )


def validate_claimed_media_type(claimed: str | None, detected: MediaType) -> None:
    if not claimed:
        return
    normalized = claimed.split(";", 1)[0].strip().lower()
    if normalized in {"", "application/octet-stream"}:
        return
    aliases = {"image/jpg": MediaType.JPEG}
    try:
        claimed_type = aliases.get(normalized, MediaType(normalized))
    except ValueError as error:
        raise UploadRejected(
            UploadErrorCode.MIME_MISMATCH,
            "The browser-reported file type does not match an accepted record type.",
        ) from error
    if claimed_type != detected:
        raise UploadRejected(
            UploadErrorCode.MIME_MISMATCH,
            "The browser-reported file type does not match the file's contents.",
        )
