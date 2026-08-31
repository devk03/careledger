import re
from dataclasses import dataclass
from uuid import UUID

from app.security.auth import AuthService
from app.storage.database import Database


@dataclass(frozen=True)
class SearchResult:
    title: str
    body: str
    document_id: UUID | None
    page_number: int | None
    score: float


class EvidenceSearchService:
    def __init__(self, database: Database, auth: AuthService) -> None:
        self._database = database
        self._auth = auth

    def search(
        self,
        plaintext_token: str,
        profile_id: UUID,
        query: str,
        *,
        limit: int = 20,
    ) -> tuple[SearchResult, ...]:
        session = self._auth.session(plaintext_token)
        expression = _safe_match_expression(query)
        if not 1 <= limit <= 50:
            raise ValueError("search limit is out of range")
        with self._database.connect(read_only=True) as connection:
            profile = connection.execute(
                "SELECT 1 FROM care_profiles WHERE id = ? AND household_id = ? "
                "AND archived_at IS NULL",
                (str(profile_id), str(session.household_id)),
            ).fetchone()
            if profile is None:
                raise ValueError("care profile was not found")
            rows = connection.execute(
                "SELECT search_entries.title, search_entries.body, search_entries.document_id, "
                "search_entries.page_number, bm25(search_entries_fts) AS score "
                "FROM search_entries_fts JOIN search_entries "
                "ON search_entries.id = search_entries_fts.rowid "
                "WHERE search_entries_fts MATCH ? AND search_entries.care_profile_id = ? "
                "ORDER BY score, search_entries.updated_at DESC LIMIT ?",
                (expression, str(profile_id), limit),
            ).fetchall()
        return tuple(
            SearchResult(
                title=row["title"],
                body=row["body"],
                document_id=UUID(row["document_id"]) if row["document_id"] else None,
                page_number=int(row["page_number"]) if row["page_number"] else None,
                score=float(row["score"]),
            )
            for row in rows
        )


def _safe_match_expression(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if not normalized or len(normalized) > 200 or "\x00" in normalized:
        raise ValueError("search text is invalid")
    return '"' + normalized.replace('"', '""') + '"'
