from pathlib import Path

from app.ingest.models import ScanReport, ScanVerdict


class NoopMalwareScanner:
    """Explicitly reports that no scanner is configured; it never claims a file is clean."""

    def scan(self, path: Path) -> ScanReport:
        del path
        return ScanReport(verdict=ScanVerdict.NOT_CONFIGURED)
