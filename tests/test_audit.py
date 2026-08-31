from pathlib import Path

from app.security.audit import verify_audit_chain
from app.security.auth import append_audit_event
from app.storage.database import Database


def _household(database: Database) -> None:
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO households (singleton, id, display_name, created_at) "
            "VALUES (1, 'household-test', 'Synthetic household', 1)"
        )


def test_audit_chain_verifies_each_link_and_event_hash(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    _household(database)
    with database.transaction() as connection:
        append_audit_event(
            connection,
            household_id="household-test",
            actor_user_id=None,
            action="synthetic_first",
            entity_kind="test",
            entity_id="one",
            outcome="success",
            occurred_at=1,
        )
        append_audit_event(
            connection,
            household_id="household-test",
            actor_user_id=None,
            action="synthetic_second",
            entity_kind="test",
            entity_id="two",
            outcome="success",
            occurred_at=2,
        )

    with database.connect(read_only=True) as connection:
        report = verify_audit_chain(connection)

    assert report.ok is True
    assert report.total_events == 2
    assert report.verified_through_sequence == 2
    assert report.error_code is None


def test_audit_verifier_detects_an_invalid_new_event_hash(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    _household(database)
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO audit_events "
            "(id, household_id, actor_user_id, action, entity_kind, entity_id, outcome, "
            "metadata_json, occurred_at, previous_hash, event_hash) "
            "VALUES ('tampered', 'household-test', NULL, 'synthetic', 'test', NULL, "
            "'success', '{}', 1, NULL, ?)",
            ("f" * 64,),
        )

    with database.connect(read_only=True) as connection:
        report = verify_audit_chain(connection)

    assert report.ok is False
    assert report.total_events == 1
    assert report.verified_through_sequence is None
    assert report.error_code == "EVENT_HASH_MISMATCH"
