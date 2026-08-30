import struct
import warnings
import zlib
from pathlib import Path

import pikepdf
from PIL import Image, UnidentifiedImageError

from app.ingest.models import Inspection, MediaType, UploadErrorCode, UploadRejected

_ACTIVE_PDF_MARKERS = (
    b"/JavaScript",
    b"/JS",
    b"/OpenAction",
    b"/AA",
    b"/Launch",
    b"/SubmitForm",
    b"/ImportData",
    b"/XFA",
    b"/EmbeddedFile",
    b"/FileAttachment",
    b"/RichMedia",
    b"/Rendition",
    b"/Movie",
    b"/Sound",
    b"/3D",
)


def inspect_upload(
    path: Path,
    media_type: MediaType,
    *,
    max_pdf_pages: int,
    max_pdf_objects: int,
    max_pdf_page_points: int,
    max_image_pixels: int,
    max_image_dimension: int,
) -> Inspection:
    if media_type == MediaType.PDF:
        return _inspect_pdf(
            path,
            max_pages=max_pdf_pages,
            max_objects=max_pdf_objects,
            max_page_points=max_pdf_page_points,
        )
    return _inspect_image(
        path,
        media_type,
        max_pixels=max_image_pixels,
        max_dimension=max_image_dimension,
    )


def _inspect_pdf(
    path: Path,
    *,
    max_pages: int,
    max_objects: int,
    max_page_points: int,
) -> Inspection:
    if _contains_marker(path, _ACTIVE_PDF_MARKERS):
        raise UploadRejected(
            UploadErrorCode.PDF_ACTIVE_CONTENT,
            "This PDF contains active or embedded content that CareLedger does not accept.",
        )
    if not _pdf_has_clean_eof(path):
        raise UploadRejected(
            UploadErrorCode.MALFORMED_PDF,
            "This PDF is incomplete or has unexpected data after its final page.",
        )

    try:
        with pikepdf.open(path, attempt_recovery=False, suppress_warnings=True) as pdf:
            if pdf.is_encrypted:
                raise UploadRejected(
                    UploadErrorCode.PDF_ENCRYPTED,
                    "Please upload an unlocked copy of this PDF.",
                )
            page_count = len(pdf.pages)
            if page_count < 1:
                raise UploadRejected(
                    UploadErrorCode.MALFORMED_PDF,
                    "This PDF does not contain any pages.",
                )
            if page_count > max_pages:
                raise UploadRejected(
                    UploadErrorCode.PDF_PAGE_LIMIT,
                    f"This PDF has more than the {max_pages}-page safety limit.",
                )
            if len(pdf.objects) > max_objects:
                raise UploadRejected(
                    UploadErrorCode.PDF_OBJECT_LIMIT,
                    "This PDF is too structurally complex to process safely.",
                )
            for page in pdf.pages:
                box = [float(value) for value in page.mediabox]
                if len(box) != 4:
                    raise UploadRejected(
                        UploadErrorCode.PDF_PAGE_GEOMETRY,
                        "A page in this PDF has invalid dimensions.",
                    )
                width = abs(box[2] - box[0])
                height = abs(box[3] - box[1])
                if width <= 0 or height <= 0 or max(width, height) > max_page_points:
                    raise UploadRejected(
                        UploadErrorCode.PDF_PAGE_GEOMETRY,
                        "A page in this PDF is too large to process safely.",
                    )
            return Inspection(page_count=page_count)
    except UploadRejected:
        raise
    except pikepdf.PasswordError as error:
        raise UploadRejected(
            UploadErrorCode.PDF_ENCRYPTED,
            "Please upload an unlocked copy of this PDF.",
        ) from error
    except pikepdf.PdfError as error:
        raise UploadRejected(
            UploadErrorCode.MALFORMED_PDF,
            "CareLedger could not safely read this PDF.",
        ) from error


def _inspect_image(
    path: Path,
    media_type: MediaType,
    *,
    max_pixels: int,
    max_dimension: int,
) -> Inspection:
    expected_format = "PNG" if media_type == MediaType.PNG else "JPEG"
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format != expected_format:
                    raise UploadRejected(
                        UploadErrorCode.MALFORMED_IMAGE,
                        "The image contents do not match the expected file type.",
                    )
                width, height = image.size
                if width > max_dimension or height > max_dimension:
                    raise UploadRejected(
                        UploadErrorCode.IMAGE_DIMENSION_LIMIT,
                        "This image is too wide or tall to process safely.",
                    )
                if width * height > max_pixels:
                    raise UploadRejected(
                        UploadErrorCode.IMAGE_PIXEL_LIMIT,
                        "This image contains too many pixels to process safely.",
                    )
                if getattr(image, "n_frames", 1) != 1:
                    raise UploadRejected(
                        UploadErrorCode.IMAGE_MULTIFRAME,
                        "Animated or multi-frame images are not supported.",
                    )
                image.verify()
            with Image.open(path) as decoded:
                decoded.load()
    except UploadRejected:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise UploadRejected(
            UploadErrorCode.IMAGE_PIXEL_LIMIT,
            "This image contains too many pixels to process safely.",
        ) from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise UploadRejected(
            UploadErrorCode.MALFORMED_IMAGE,
            "CareLedger could not safely read this image.",
        ) from error

    if media_type == MediaType.PNG:
        _validate_png_container(path)
    elif not _jpeg_has_clean_eoi(path):
        raise UploadRejected(
            UploadErrorCode.IMAGE_TRAILING_DATA,
            "This JPEG contains unexpected data after the image.",
        )
    return Inspection(width=width, height=height)


def _validate_png_container(path: Path) -> None:
    data = path.read_bytes()
    offset = 8
    seen_ihdr = False
    seen_iend = False
    while offset < len(data):
        if offset + 12 > len(data):
            break
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_end = offset + 12 + length
        if chunk_end > len(data):
            break
        chunk_data = data[offset + 8 : offset + 8 + length]
        expected_crc = struct.unpack(">I", data[offset + 8 + length : chunk_end])[0]
        actual_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            break
        if chunk_type == b"IHDR":
            if seen_ihdr or offset != 8:
                break
            seen_ihdr = True
        if chunk_type == b"acTL":
            raise UploadRejected(
                UploadErrorCode.IMAGE_MULTIFRAME,
                "Animated or multi-frame images are not supported.",
            )
        offset = chunk_end
        if chunk_type == b"IEND":
            seen_iend = True
            break
    if not seen_ihdr or not seen_iend or offset != len(data):
        raise UploadRejected(
            UploadErrorCode.IMAGE_TRAILING_DATA,
            "This PNG is incomplete or contains unexpected trailing data.",
        )


def _jpeg_has_clean_eoi(path: Path) -> bool:
    with path.open("rb") as handle:
        handle.seek(-2, 2)
        return handle.read(2) == b"\xff\xd9"


def _pdf_has_clean_eof(path: Path) -> bool:
    with path.open("rb") as handle:
        handle.seek(max(path.stat().st_size - 2048, 0))
        tail = handle.read()
    return tail.rstrip(b"\x00\x09\x0a\x0c\x0d\x20").endswith(b"%%EOF")


def _contains_marker(path: Path, markers: tuple[bytes, ...]) -> bool:
    overlap = max(len(marker) for marker in markers) - 1
    previous = b""
    with path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            window = previous + chunk
            if any(marker in window for marker in markers):
                return True
            previous = window[-overlap:]
    return False
