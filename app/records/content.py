from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from app.security.auth import AuthService
from app.storage.database import Database
from app.storage.objects import ContentAddressedObjectStore


@dataclass(frozen=True)
class DocumentContent:
    path: Path
    media_type: str
    source_sha256: str


class DocumentContentNotFound(RuntimeError):
    pass


class DocumentContentService:
    def __init__(
        self,
        database: Database,
        auth: AuthService,
        object_store: ContentAddressedObjectStore,
    ) -> None:
        self._database = database
        self._auth = auth
        self._objects = object_store

    def open(self, plaintext_token: str, document_id: UUID) -> DocumentContent:
        session = self._auth.session(plaintext_token)
        with self._database.connect(read_only=True) as connection:
            row = connection.execute(
                "SELECT documents.source_sha256, source_objects.media_type FROM documents "
                "JOIN care_profiles ON care_profiles.id = documents.care_profile_id "
                "JOIN source_objects ON source_objects.sha256 = documents.source_sha256 "
                "WHERE documents.id = ? AND care_profiles.household_id = ? "
                "AND documents.archived_at IS NULL",
                (str(document_id), str(session.household_id)),
            ).fetchone()
        if row is None or not self._objects.verify(row["source_sha256"]):
            raise DocumentContentNotFound
        return DocumentContent(
            path=self._objects.path_for(row["source_sha256"]),
            media_type=row["media_type"],
            source_sha256=row["source_sha256"],
        )
