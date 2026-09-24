"""Synthetic-only checks for the unregistered local-store migration draft."""

import sqlite3
from pathlib import Path

import pytest

from app.storage.database import CURRENT_SCHEMA_VERSION, MIGRATIONS, Database, _statements

SQL_PATH = Path(__file__).resolve().parents[1] / "app/storage/migrations/0006_sparse_care_days.sql"


def _fictional_database(tmp_path: Path) -> sqlite3.Connection:
    database = Database(tmp_path / "fictional-only.sqlite")
    database.initialize()
    connection = sqlite3.connect(database.path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    for statement in _statements(SQL_PATH.read_text(encoding="utf-8")):
        connection.execute(statement)

    connection.execute(
        "INSERT INTO households (singleton, id, display_name, created_at) "
        "VALUES (1, 'fictional-household', 'Fictional household', 10)"
    )
    connection.execute(
        "INSERT INTO users (id, household_id, login_name, login_name_normalized, "
        "display_name, role, status, password_hash, created_at, updated_at, "
        "password_changed_at) VALUES "
        "('fictional-owner', 'fictional-household', 'owner', 'owner', "
        "'Fictional owner', 'owner', 'active', '$argon2id$fictional', 10, 10, 10)"
    )
    connection.execute(
        "INSERT INTO users (id, household_id, login_name, login_name_normalized, "
        "display_name, role, status, created_at, updated_at) VALUES "
        "('fictional-pending', 'fictional-household', 'pending', 'pending', "
        "'Fictional pending user', 'caregiver', 'pending', 10, 10)"
    )
    for profile in ("fictional-profile-a", "fictional-profile-b"):
        connection.execute(
            "INSERT INTO care_profiles (id, household_id, preferred_name, created_by, "
            "created_at, updated_at) VALUES (?, 'fictional-household', ?, "
            "'fictional-owner', 10, 10)",
            (profile, profile),
        )
    connection.execute(
        "INSERT INTO source_objects (sha256, byte_size, media_type, created_at) "
        "VALUES (?, 12, 'application/pdf', 10)",
        ("f" * 64,),
    )
    for document in ("fictional-document-a", "fictional-document-b"):
        connection.execute(
            "INSERT INTO documents (id, care_profile_id, source_sha256, "
            "original_display_name, scan_verdict, status, uploaded_by, uploaded_at) "
            "VALUES (?, 'fictional-profile-a', ?, 'fictional.pdf', 'clean', "
            "'processing', 'fictional-owner', 20)",
            (document, "f" * 64),
        )
    connection.commit()
    return connection


def _placement(connection: sqlite3.Connection, placement_id: str, document_id: str) -> None:
    connection.execute(
        "INSERT INTO document_day_placements "
        "(id, care_profile_id, document_id, created_by, created_at) "
        "VALUES (?, 'fictional-profile-a', ?, 'fictional-owner', 21)",
        (placement_id, document_id),
    )


def _placement_revision(
    connection: sqlite3.Connection,
    revision_id: str,
    placement_id: str,
    revision_no: int,
    care_day: str,
    *,
    retracted: bool = False,
    decision: str | None = None,
) -> None:
    connection.execute(
        "INSERT INTO document_day_placement_revisions "
        "(id, placement_id, revision_no, care_day, is_retracted, created_by, created_at) "
        "VALUES (?, ?, ?, ?, ?, 'fictional-owner', ?)",
        (revision_id, placement_id, revision_no, care_day, int(retracted), 22 + revision_no),
    )
    if decision is not None:
        connection.execute(
            "INSERT INTO document_day_placement_reviews "
            "(id, revision_id, decision, reviewer_id, decided_at) "
            "VALUES (?, ?, ?, 'fictional-owner', ?)",
            (f"review-{revision_id}", revision_id, decision, 32 + revision_no),
        )


def test_draft_is_additive_unregistered_and_applies_only_to_fictional_database(
    tmp_path: Path,
) -> None:
    sql = SQL_PATH.read_text(encoding="utf-8").upper()
    assert CURRENT_SCHEMA_VERSION == 5
    assert all(migration.version != 6 for migration in MIGRATIONS)
    assert all(term not in sql for term in ("DROP TABLE", "DROP INDEX", "DELETE FROM"))

    with _fictional_database(tmp_path) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema")}
        assert {
            "document_day_placements",
            "family_notes",
            "current_accepted_document_days",
        } <= tables
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_approved_history_keeps_prior_version_until_new_one_is_accepted(
    tmp_path: Path,
) -> None:
    with _fictional_database(tmp_path) as connection:
        _placement(connection, "placement-a", "fictional-document-a")
        _placement_revision(
            connection, "revision-1", "placement-a", 1, "2026-01-02", decision="accepted"
        )
        _placement_revision(connection, "revision-2", "placement-a", 2, "2026-01-03")
        _placement_revision(
            connection, "revision-3", "placement-a", 3, "2026-01-04", decision="rejected"
        )
        current = connection.execute(
            "SELECT care_day FROM current_accepted_document_days WHERE placement_id = 'placement-a'"
        ).fetchone()
        assert current[0] == "2026-01-02"

        _placement_revision(
            connection, "revision-4", "placement-a", 4, "2026-01-05", decision="accepted"
        )
        assert (
            connection.execute(
                "SELECT care_day FROM current_accepted_document_days "
                "WHERE placement_id = 'placement-a'"
            ).fetchone()[0]
            == "2026-01-05"
        )

        _placement(connection, "placement-b", "fictional-document-b")
        _placement_revision(
            connection, "revision-b", "placement-b", 1, "2026-01-05", decision="accepted"
        )
        _placement(connection, "placement-c", "fictional-document-a")
        _placement_revision(
            connection, "revision-c", "placement-c", 1, "2026-01-06", decision="accepted"
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM current_accepted_document_days WHERE care_day = '2026-01-05'"
            ).fetchone()[0]
            == 2
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM current_accepted_document_days "
                "WHERE document_id = 'fictional-document-a'"
            ).fetchone()[0]
            == 2
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM current_accepted_document_days WHERE care_day = '2026-01-04'"
            ).fetchone()[0]
            == 0
        )

        _placement_revision(
            connection,
            "revision-5",
            "placement-a",
            5,
            "2026-01-05",
            retracted=True,
            decision="accepted",
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM current_accepted_document_days "
                "WHERE placement_id = 'placement-a'"
            ).fetchone()[0]
            == 0
        )


def test_cross_profile_and_inactive_actor_are_rejected(tmp_path: Path) -> None:
    with _fictional_database(tmp_path) as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO document_day_placements "
                "(id, care_profile_id, document_id, created_by, created_at) "
                "VALUES ('wrong-profile', 'fictional-profile-b', 'fictional-document-a', "
                "'fictional-owner', 21)"
            )
        with pytest.raises(sqlite3.IntegrityError, match="creator must be active"):
            connection.execute(
                "INSERT INTO document_day_placements "
                "(id, care_profile_id, document_id, created_by, created_at) "
                "VALUES ('pending-actor', 'fictional-profile-a', 'fictional-document-a', "
                "'fictional-pending', 21)"
            )
        _placement(connection, "placement-a", "fictional-document-a")
        with pytest.raises(sqlite3.IntegrityError):
            _placement_revision(connection, "bad-day", "placement-a", 1, "2026-1-5")
        with pytest.raises(sqlite3.IntegrityError):
            _placement_revision(connection, "impossible-day", "placement-a", 1, "2026-02-30")
        _placement_revision(connection, "revision-1", "placement-a", 1, "2026-01-05")
        with pytest.raises(sqlite3.IntegrityError, match="reviewer scope"):
            connection.execute(
                "INSERT INTO document_day_placement_reviews "
                "(id, revision_id, decision, reviewer_id, decided_at) "
                "VALUES ('pending-review', 'revision-1', 'accepted', 'fictional-pending', 40)"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE document_day_placement_revisions SET care_day = '2026-01-06' "
                "WHERE id = 'revision-1'"
            )


def test_accepted_undated_family_note_and_later_correction(tmp_path: Path) -> None:
    with _fictional_database(tmp_path) as connection:
        connection.execute(
            "INSERT INTO family_notes (id, care_profile_id, created_by, created_at) "
            "VALUES ('note-a', 'fictional-profile-a', 'fictional-owner', 21)"
        )
        connection.execute(
            "INSERT INTO family_note_revisions "
            "(id, note_id, revision_no, care_day, body, created_by, created_at) "
            "VALUES ('note-revision-1', 'note-a', 1, NULL, "
            "'Fictional family recollection; date uncertain.', 'fictional-owner', 22)"
        )
        connection.execute(
            "INSERT INTO family_note_reviews "
            "(id, revision_id, decision, reviewer_id, decided_at) "
            "VALUES ('note-review-1', 'note-revision-1', 'accepted', 'fictional-owner', 23)"
        )
        connection.execute(
            "INSERT INTO family_note_revisions "
            "(id, note_id, revision_no, care_day, body, created_by, created_at) "
            "VALUES ('note-revision-2', 'note-a', 2, '2026-01-07', "
            "'Fictional correction.', 'fictional-owner', 24)"
        )
        assert tuple(
            connection.execute(
                "SELECT care_day, body FROM current_accepted_family_notes WHERE note_id = 'note-a'"
            ).fetchone()
        ) == (None, "Fictional family recollection; date uncertain.")
        connection.execute(
            "INSERT INTO family_note_reviews "
            "(id, revision_id, decision, reviewer_id, decided_at) "
            "VALUES ('note-review-2', 'note-revision-2', 'accepted', 'fictional-owner', 25)"
        )
        assert (
            connection.execute(
                "SELECT care_day FROM current_accepted_family_notes WHERE note_id = 'note-a'"
            ).fetchone()[0]
            == "2026-01-07"
        )
