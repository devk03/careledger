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
    assert first.migration_count == 4
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
