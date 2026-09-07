import sqlite3
from pathlib import Path

import pytest

from app.storage.database import (
    APPLICATION_ID,
    CURRENT_SCHEMA_VERSION,
    MIGRATIONS,
    Database,
    Migration,
    SchemaError,
    SchemaErrorCode,
)


def _bootstrap_managed_household(connection: sqlite3.Connection) -> None:
    """Create only synthetic identity and key metadata for managed-schema tests."""
    connection.execute(
        "INSERT INTO households (singleton, id, display_name, created_at) "
        "VALUES (1, 'household-test', 'Synthetic household', 10)"
    )
    connection.execute(
        "INSERT INTO users "
        "(id, household_id, login_name, login_name_normalized, display_name, role, status, "
        "password_hash, auth_version, created_at, updated_at, password_changed_at, "
        "disabled_at) VALUES "
        "('user-test', 'household-test', 'owner', 'owner', 'Synthetic organizer', "
        "'owner', 'active', '$argon2id$synthetic', 1, 10, 10, 10, NULL)"
    )
    connection.execute(
        "INSERT INTO managed_household_state "
        "(household_id, format_version, current_key_epoch, head_sequence, "
        "head_manifest_sha256, ciphertext_bytes, quota_bytes, created_at, updated_at) "
        "VALUES ('household-test', 1, 0, 0, NULL, 0, 10485760, 10, 10)"
    )
    connection.execute(
        "INSERT INTO managed_devices "
        "(household_id, id, user_id, state, encryption_algorithm, encryption_public_key, "
        "signing_algorithm, signing_public_key, created_at, activated_at, revoked_at) "
        "VALUES ('household-test', 'device-test', 'user-test', 'active', 'x25519', ?, "
        "'ed25519', ?, 10, 10, NULL)",
        (b"e" * 32, b"s" * 32),
    )
    connection.execute(
        "INSERT INTO managed_device_grants "
        "(household_id, device_id, role, state, granted_by_device_id, device_counter, "
        "signature, granted_at, revoked_at) VALUES "
        "('household-test', 'device-test', 'admin', 'active', 'device-test', 1, ?, 10, NULL)",
        (b"g" * 64,),
    )
    connection.execute(
        "INSERT INTO managed_key_epochs "
        "(household_id, key_epoch, previous_key_epoch, key_commitment, "
        "created_by_device_id, device_counter, signature, created_at) VALUES "
        "('household-test', 1, NULL, ?, 'device-test', 2, ?, 11)",
        (b"k" * 32, b"q" * 64),
    )


@pytest.mark.parametrize("migration", MIGRATIONS)
def test_migrations_are_forward_only(migration: Migration) -> None:
    sql = migration.sql().upper()

    assert "DROP TABLE" not in sql
    assert "DROP INDEX" not in sql
    assert "DELETE FROM" not in sql


def test_fresh_database_initializes_and_reapplies_without_changes(tmp_path: Path) -> None:
    path = tmp_path / "app.sqlite"
    database = Database(path)

    first = database.initialize()
    second = database.initialize()

    assert first == second
    assert first.version == CURRENT_SCHEMA_VERSION
    assert first.application_id == APPLICATION_ID
    assert first.migration_count == 5
    assert path.stat().st_mode & 0o777 == 0o600
    assert database.is_setup_complete() is False

    with database.connect(read_only=True) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')"
            ).fetchall()
        }
        assert {
            "users",
            "sessions",
            "source_objects",
            "documents",
            "extraction_runs",
            "evidence_claim_revisions",
            "citations",
            "timeline_event_revisions",
            "question_revisions",
            "decision_revisions",
            "followup_revisions",
            "audit_events",
            "current_evidence_claim_revisions",
            "managed_household_state",
            "managed_devices",
            "managed_enrollment_challenges",
            "managed_device_grants",
            "managed_key_epochs",
            "managed_device_key_envelopes",
            "managed_recovery_envelopes",
            "managed_nonces",
            "managed_blob_uploads",
            "managed_blob_chunks",
            "managed_committed_blobs",
            "managed_manifests",
            "managed_device_checkpoints",
            "managed_deletion_tombstones",
        }.issubset(tables)
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA query_only").fetchone()[0] == 1
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_unknown_and_newer_schemas_fail_closed(tmp_path: Path) -> None:
    unknown_path = tmp_path / "unknown.sqlite"
    connection = sqlite3.connect(unknown_path)
    connection.execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")
    connection.commit()
    connection.close()

    with pytest.raises(SchemaError) as unknown:
        Database(unknown_path).initialize()
    assert unknown.value.code == SchemaErrorCode.UNKNOWN_SCHEMA

    newer_path = tmp_path / "newer.sqlite"
    connection = sqlite3.connect(newer_path)
    connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
    connection.execute(f"PRAGMA user_version = {CURRENT_SCHEMA_VERSION + 1}")
    connection.close()

    with pytest.raises(SchemaError) as newer:
        Database(newer_path).initialize()
    assert newer.value.code == SchemaErrorCode.NEWER_SCHEMA


def test_migration_checksum_tampering_fails_closed(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        connection.execute(
            "UPDATE schema_migrations SET sha256 = ? WHERE version = 1",
            ("0" * 64,),
        )

    with pytest.raises(SchemaError) as mismatch:
        database.verify()
    assert mismatch.value.code == SchemaErrorCode.MIGRATION_HASH_MISMATCH


def test_original_sources_and_audit_events_reject_mutation(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO source_objects (sha256, byte_size, media_type, created_at) "
            "VALUES (?, ?, ?, ?)",
            ("a" * 64, 12, "application/pdf", 1),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE source_objects SET byte_size = 13 WHERE sha256 = ?",
                ("a" * 64,),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("DELETE FROM source_objects WHERE sha256 = ?", ("a" * 64,))

        connection.execute(
            "INSERT INTO households (singleton, id, display_name, created_at) "
            "VALUES (1, 'household-test', 'Synthetic household', 1)"
        )
        connection.execute(
            "INSERT INTO audit_events "
            "(id, household_id, actor_user_id, action, entity_kind, entity_id, outcome, "
            "metadata_json, occurred_at, previous_hash, event_hash) "
            "VALUES (?, ?, NULL, ?, ?, NULL, ?, '{}', ?, NULL, ?)",
            ("event-test", "household-test", "setup", "system", "success", 1, "b" * 64),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE audit_events SET outcome = 'failure' WHERE id = 'event-test'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("DELETE FROM audit_events WHERE id = 'event-test'")


def test_deferred_child_first_citations_are_insertable_and_profile_scoped(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO households (singleton, id, display_name, created_at) "
            "VALUES (1, 'household-test', 'Synthetic household', 1)"
        )
        connection.execute(
            "INSERT INTO users "
            "(id, household_id, login_name, login_name_normalized, display_name, role, status, "
            "password_hash, auth_version, created_at, updated_at, password_changed_at, "
            "disabled_at) "
            "VALUES ('user-test', 'household-test', 'owner', 'owner', 'Synthetic organizer', "
            "'owner', 'active', '$argon2id$synthetic', 1, 1, 1, 1, NULL)"
        )
        for profile_id in ("profile-one", "profile-two"):
            connection.execute(
                "INSERT INTO care_profiles "
                "(id, household_id, preferred_name, birth_date, created_by, created_at, "
                "updated_at, archived_at) VALUES (?, 'household-test', ?, NULL, "
                "'user-test', 1, 1, NULL)",
                (profile_id, f"Synthetic {profile_id}"),
            )
        connection.execute(
            "INSERT INTO source_objects (sha256, byte_size, media_type, created_at) "
            "VALUES (?, 12, 'application/pdf', 1)",
            ("a" * 64,),
        )
        for document_id, profile_id in (
            ("document-one", "profile-one"),
            ("document-two", "profile-two"),
        ):
            connection.execute(
                "INSERT INTO documents "
                "(id, care_profile_id, source_sha256, original_display_name, scan_verdict, "
                "page_count, status, uploaded_by, uploaded_at, archived_at) "
                "VALUES (?, ?, ?, 'synthetic.pdf', 'clean', 1, 'processing', "
                "'user-test', 1, NULL)",
                (document_id, profile_id, "a" * 64),
            )
            connection.execute(
                "INSERT INTO document_pages "
                "(document_id, page_number, created_at) VALUES (?, 1, 1)",
                (document_id,),
            )
        connection.execute(
            "INSERT INTO evidence_claims (id, care_profile_id, created_at) "
            "VALUES ('claim-one', 'profile-one', 1)"
        )

    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO citations "
            "(id, claim_revision_id, document_id, source_sha256, page_number, quote, position) "
            "VALUES ('citation-valid', 'revision-valid', 'document-one', ?, 1, "
            "'SYNTHETIC TEST RECORD', 0)",
            ("a" * 64,),
        )
        connection.execute(
            "INSERT INTO evidence_claim_revisions "
            "(id, claim_id, revision_no, kind, review_state, statement, certainty, "
            "citation_count, created_by, created_at) VALUES "
            "('revision-valid', 'claim-one', 1, 'source_documented_fact', 'accepted', "
            "'SYNTHETIC TEST RECORD', 'explicit', 1, 'user-test', 1)"
        )

    with pytest.raises(sqlite3.IntegrityError), database.transaction() as connection:
        connection.execute(
            "INSERT INTO citations "
            "(id, claim_revision_id, document_id, source_sha256, page_number, quote, position) "
            "VALUES ('citation-crossed', 'revision-crossed', 'document-two', ?, 1, "
            "'SYNTHETIC TEST RECORD', 0)",
            ("a" * 64,),
        )
        connection.execute(
            "INSERT INTO evidence_claim_revisions "
            "(id, claim_id, revision_no, kind, review_state, statement, certainty, "
            "citation_count, created_by, created_at) VALUES "
            "('revision-crossed', 'claim-one', 2, 'source_documented_fact', 'accepted', "
            "'SYNTHETIC TEST RECORD', 'explicit', 1, 'user-test', 2)"
        )


def test_existing_version_four_database_upgrades_to_managed_schema(tmp_path: Path) -> None:
    path = tmp_path / "version-four.sqlite"
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA trusted_schema = ON")
    for migration in MIGRATIONS[:4]:
        connection.executescript(migration.sql())
        connection.execute(
            "INSERT INTO schema_migrations "
            "(version, name, sha256, app_version, applied_at) VALUES (?, ?, ?, 'test', 1)",
            (migration.version, migration.name, migration.sha256()),
        )
    connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
    connection.execute("PRAGMA user_version = 4")
    connection.commit()
    connection.close()

    status = Database(path).initialize()

    assert status.version == 5
    assert status.migration_count == 5
    with Database(path).connect(read_only=True) as upgraded:
        assert (
            upgraded.execute(
                "SELECT COUNT(*) FROM sqlite_schema "
                "WHERE type = 'table' AND name = 'managed_household_state'"
            ).fetchone()[0]
            == 1
        )
        assert upgraded.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_managed_nonce_reuse_and_incomplete_blob_commit_fail_closed(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        _bootstrap_managed_household(connection)
        connection.execute(
            "INSERT INTO managed_blob_uploads "
            "(household_id, blob_id, opaque_object_id, object_version, key_epoch, "
            "format_version, plaintext_size, ciphertext_size, chunk_size, chunk_count, "
            "created_by_device_id, created_at, expires_at) VALUES "
            "('household-test', 'blob-one', 'object-one', 1, 1, 1, 5, 21, 1048576, 1, "
            "'device-test', 12, 1000)"
        )
        with pytest.raises(sqlite3.IntegrityError, match="incomplete or unauthorized"):
            connection.execute(
                "INSERT INTO managed_committed_blobs "
                "(household_id, blob_id, opaque_object_id, object_version, ciphertext_root, "
                "committed_by_device_id, device_counter, signature, committed_at) VALUES "
                "('household-test', 'blob-one', 'object-one', 1, ?, 'device-test', 3, ?, 13)",
                (b"r" * 32, b"c" * 64),
            )
        connection.execute(
            "INSERT INTO managed_nonces "
            "(household_id, id, key_epoch, nonce, purpose, scope_id, created_at) VALUES "
            "('household-test', 'nonce-one', 1, ?, 'blob_chunk', 'blob-one:0', 13)",
            (b"n" * 12,),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO managed_nonces "
                "(household_id, id, key_epoch, nonce, purpose, scope_id, created_at) VALUES "
                "('household-test', 'nonce-reuse', 1, ?, 'blob_chunk', 'blob-two:0', 13)",
                (b"n" * 12,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="scope or size is invalid"):
            connection.execute(
                "INSERT INTO managed_blob_chunks "
                "(household_id, blob_id, chunk_index, nonce_id, ciphertext_size, "
                "ciphertext_sha256, storage_object_id, created_at) VALUES "
                "('household-test', 'blob-one', 0, 'nonce-one', 20, ?, 'stored-one', 14)",
                (b"h" * 32,),
            )
        connection.execute(
            "INSERT INTO managed_blob_chunks "
            "(household_id, blob_id, chunk_index, nonce_id, ciphertext_size, "
            "ciphertext_sha256, storage_object_id, created_at) VALUES "
            "('household-test', 'blob-one', 0, 'nonce-one', 21, ?, 'stored-one', 14)",
            (b"h" * 32,),
        )
        connection.execute(
            "INSERT INTO managed_committed_blobs "
            "(household_id, blob_id, opaque_object_id, object_version, ciphertext_root, "
            "committed_by_device_id, device_counter, signature, committed_at) VALUES "
            "('household-test', 'blob-one', 'object-one', 1, ?, 'device-test', 3, ?, 15)",
            (b"r" * 32, b"c" * 64),
        )
        assert connection.execute(
            "SELECT ciphertext_bytes FROM managed_household_state "
            "WHERE household_id = 'household-test'"
        ).fetchone()[0] == 21
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE managed_blob_chunks SET ciphertext_size = 20 "
                "WHERE household_id = 'household-test' AND blob_id = 'blob-one'"
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "DELETE FROM managed_blob_chunks "
                "WHERE household_id = 'household-test' AND blob_id = 'blob-one'"
            )


def test_managed_manifest_compare_and_swap_and_checkpoints_fail_closed(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    with database.connect() as connection:
        _bootstrap_managed_household(connection)
        for nonce_id, nonce, scope, created_at in (
            ("manifest-nonce-one", b"1" * 12, "manifest-one", 20),
            ("manifest-nonce-gap", b"2" * 12, "manifest-gap", 21),
            ("manifest-nonce-wrong", b"3" * 12, "manifest-wrong", 22),
            ("manifest-nonce-two", b"4" * 12, "manifest-two", 23),
        ):
            connection.execute(
                "INSERT INTO managed_nonces "
                "(household_id, id, key_epoch, nonce, purpose, scope_id, created_at) "
                "VALUES ('household-test', ?, 1, ?, 'manifest', ?, ?)",
                (nonce_id, nonce, scope, created_at),
            )
        connection.execute(
            "INSERT INTO managed_manifests "
            "(household_id, sequence, id, key_epoch, previous_manifest_sha256, nonce_id, "
            "ciphertext, manifest_sha256, author_device_id, device_counter, signature, "
            "created_at) VALUES "
            "('household-test', 1, 'manifest-one', 1, NULL, 'manifest-nonce-one', ?, ?, "
            "'device-test', 3, ?, 20)",
            (b"x" * 17, b"a" * 32, b"m" * 64),
        )
        with pytest.raises(sqlite3.IntegrityError, match="compare-and-swap"):
            connection.execute(
                "INSERT INTO managed_manifests "
                "(household_id, sequence, id, key_epoch, previous_manifest_sha256, nonce_id, "
                "ciphertext, manifest_sha256, author_device_id, device_counter, signature, "
                "created_at) VALUES "
                "('household-test', 3, 'manifest-gap', 1, ?, 'manifest-nonce-gap', ?, ?, "
                "'device-test', 4, ?, 21)",
                (b"a" * 32, b"y" * 17, b"b" * 32, b"n" * 64),
            )
        with pytest.raises(sqlite3.IntegrityError, match="compare-and-swap"):
            connection.execute(
                "INSERT INTO managed_manifests "
                "(household_id, sequence, id, key_epoch, previous_manifest_sha256, nonce_id, "
                "ciphertext, manifest_sha256, author_device_id, device_counter, signature, "
                "created_at) VALUES "
                "('household-test', 2, 'manifest-wrong', 1, ?, 'manifest-nonce-wrong', ?, ?, "
                "'device-test', 5, ?, 22)",
                (b"z" * 32, b"z" * 17, b"c" * 32, b"o" * 64),
            )
        connection.execute(
            "INSERT INTO managed_manifests "
            "(household_id, sequence, id, key_epoch, previous_manifest_sha256, nonce_id, "
            "ciphertext, manifest_sha256, author_device_id, device_counter, signature, "
            "created_at) VALUES "
            "('household-test', 2, 'manifest-two', 1, ?, 'manifest-nonce-two', ?, ?, "
            "'device-test', 6, ?, 23)",
            (b"a" * 32, b"w" * 17, b"d" * 32, b"p" * 64),
        )
        state = connection.execute(
            "SELECT head_sequence, head_manifest_sha256 FROM managed_household_state "
            "WHERE household_id = 'household-test'"
        ).fetchone()
        assert tuple(state) == (2, b"d" * 32)
        connection.execute(
            "INSERT INTO managed_device_checkpoints "
            "(household_id, device_id, observed_sequence, observed_manifest_sha256, "
            "device_counter, signature, created_at) VALUES "
            "('household-test', 'device-test', 2, ?, 7, ?, 24)",
            (b"d" * 32, b"t" * 64),
        )
        with pytest.raises(sqlite3.IntegrityError, match="stale or invalid"):
            connection.execute(
                "INSERT INTO managed_device_checkpoints "
                "(household_id, device_id, observed_sequence, observed_manifest_sha256, "
                "device_counter, signature, created_at) VALUES "
                "('household-test', 'device-test', 1, ?, 8, ?, 25)",
                (b"a" * 32, b"u" * 64),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE managed_manifests SET ciphertext = ? "
                "WHERE household_id = 'household-test' AND sequence = 2",
                (b"v" * 17,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "DELETE FROM managed_manifests "
                "WHERE household_id = 'household-test' AND sequence = 2"
            )


def test_managed_schema_has_no_plaintext_health_record_fields(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    forbidden_tokens = {
        "answer",
        "content",
        "diagnosis",
        "document",
        "filename",
        "medical",
        "mime",
        "name",
        "patient",
        "question",
        "record",
        "text",
        "title",
    }
    with database.connect(read_only=True) as connection:
        managed_tables = connection.execute(
            "SELECT name FROM sqlite_schema "
            "WHERE type = 'table' AND name LIKE 'managed_%'"
        ).fetchall()
        assert managed_tables
        for table in managed_tables:
            columns = connection.execute(f"PRAGMA table_info({table['name']})").fetchall()
            for column in columns:
                normalized = column["name"].lower()
                assert forbidden_tokens.isdisjoint(normalized.split("_")), (
                    table["name"],
                    normalized,
                )
