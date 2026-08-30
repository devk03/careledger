import re
import unicodedata

from app.ingest.models import MediaType, UploadErrorCode, UploadRejected

_ALLOWED_PUNCTUATION = {"-", "_", ".", "(", ")", "[", "]"}
_RESERVED_STEMS = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}
_EXTENSIONS = {
    MediaType.PDF: {".pdf"},
    MediaType.JPEG: {".jpg", ".jpeg"},
    MediaType.PNG: {".png"},
}
_CANONICAL_EXTENSION = {
    MediaType.PDF: ".pdf",
    MediaType.JPEG: ".jpg",
    MediaType.PNG: ".png",
}


def safe_display_name(raw_name: str, media_type: MediaType, *, max_bytes: int = 120) -> str:
    basename = raw_name.replace("\\", "/").split("/")[-1]
    normalized = unicodedata.normalize("NFKC", basename)
    normalized = "".join(
        character
        for character in normalized
        if unicodedata.category(character) not in {"Cc", "Cf", "Cs"}
    )
    normalized = re.sub(r"\s+", " ", normalized).strip(" .")

    cleaned = "".join(
        character
        if character.isalnum() or character.isspace() or character in _ALLOWED_PUNCTUATION
        else "-"
        for character in normalized
    )
    cleaned = re.sub(r"-+", "-", cleaned).strip(" .-")

    dot = cleaned.rfind(".")
    provided_extension = cleaned[dot:].lower() if dot >= 0 else ""
    stem = cleaned[:dot] if dot >= 0 else cleaned
    if provided_extension and provided_extension not in _EXTENSIONS[media_type]:
        raise UploadRejected(
            UploadErrorCode.EXTENSION_MISMATCH,
            "The filename does not match the file's actual type.",
        )

    stem = stem.strip(" .-")
    if not stem or stem.upper() in _RESERVED_STEMS:
        stem = "health-record"

    extension = _CANONICAL_EXTENSION[media_type]
    budget = max_bytes - len(extension.encode("utf-8"))
    stem = _truncate_utf8(stem, max(budget, 1)).rstrip(" .-") or "health-record"
    return f"{stem}{extension}"


def _truncate_utf8(value: str, byte_limit: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= byte_limit:
        return value
    return encoded[:byte_limit].decode("utf-8", errors="ignore")
