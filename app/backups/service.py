from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.security.auth import AuthError, AuthErrorCode, AuthService, append_audit_event
from app.storage.database import CURRENT_SCHEMA_VERSION, Database
from app.storage.objects import ContentAddressedObjectStore
from app.storage.portable_backup import BackupReceipt, export_portable_backup
from app.storage.sqlite_snapshot import create_sqlite_snapshot


@dataclass(frozen=True)
class BackupExport:
    path: Path
    receipt: BackupReceipt


class BackupService:
    def __init__(
        self,
        database: Database,
        auth: AuthService,
        object_store: ContentAddressedObjectStore,
        backup_dir: Path,
        recovery_pepper_path: Path,
    ) -> None:
        self._database = database
        self._auth = auth
        self._objects = object_store
        self._backup_dir = backup_dir
        self._recovery_pepper_path = recovery_pepper_path

    def export(
        self,
        plaintext_token: str,
        csrf_token: str,
        account_password: str,
        backup_passphrase: str,
        *,
        now: int | None = None,
    ) -> BackupExport:
        timestamp = now or int(datetime.now(UTC).timestamp())
        record = self._auth.reauthenticate(plaintext_token, account_password, now=timestamp)
        if record.user.role != "owner":
            raise AuthError(AuthErrorCode.INVALID_CREDENTIALS)
        with self._database.transaction() as connection:
            self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
        self._backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        export_id = uuid4()
        snapshot = self._backup_dir / f"snapshot-{export_id}.sqlite"
        destination = self._backup_dir / f"careledger-{export_id}.clb"
        try:
            create_sqlite_snapshot(self._database.path, snapshot)
            receipt = export_portable_backup(
                self._objects,
                destination,
                backup_passphrase,
                database_snapshot=snapshot,
                recovery_pepper=self._recovery_pepper_path,
                schema_version=CURRENT_SCHEMA_VERSION,
            )
        finally:
            snapshot.unlink(missing_ok=True)
        with self._database.transaction() as connection:
            self._auth.authorize_mutation(
                connection,
                plaintext_token,
                csrf_token,
                now=timestamp,
            )
            append_audit_event(
                connection,
                household_id=str(record.household_id),
                actor_user_id=str(record.user.id),
                action="encrypted_backup_created",
                entity_kind="backup",
                entity_id=str(receipt.export_id),
                outcome="success",
                occurred_at=timestamp,
            )
        return BackupExport(path=destination, receipt=receipt)
