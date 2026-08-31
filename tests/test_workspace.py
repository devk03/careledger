from pathlib import Path
from uuid import UUID, uuid4

from app.security.audit import verify_audit_chain
from app.security.auth import AuthService
from app.security.bootstrap import BootstrapManager
from app.security.passwords import PasswordManager
from app.storage.database import Database
from app.workspace.service import CareWorkspaceService


def _service(tmp_path: Path) -> tuple[Database, CareWorkspaceService, str, str, str]:
    database = Database(tmp_path / "app.sqlite")
    database.initialize()
    bootstrap = BootstrapManager(tmp_path / "secrets", "https://localhost:8080")
    state = bootstrap.initialize(setup_complete=False)
    assert state.setup_url is not None
    setup_token = (tmp_path / "secrets" / "bootstrap-token").read_text(encoding="utf-8")
    auth = AuthService(
        database,
        bootstrap,
        b"r" * 32,
        passwords=PasswordManager(time_cost=1, memory_cost=8_192, parallelism=1),
    )
    owner = auth.setup_owner(
        setup_token,
        "synthetic owner passphrase",
        display_name="Synthetic organizer",
        household_name="Synthetic household",
        now=1_800_000_000,
    )
    session = auth.session(owner.plaintext_token, now=1_800_000_001)
    profile_id = str(uuid4())
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO care_profiles "
            "(id, household_id, preferred_name, birth_date, created_by, created_at, updated_at, "
            "archived_at) VALUES (?, ?, 'Synthetic loved one', NULL, ?, ?, ?, NULL)",
            (
                profile_id,
                str(session.household_id),
                str(session.user.id),
                1_800_000_001,
                1_800_000_001,
            ),
        )
    return (
        database,
        CareWorkspaceService(database, auth),
        owner.plaintext_token,
        owner.csrf_token,
        profile_id,
    )


def test_caregiver_workflow_is_persistent_prioritized_and_revisioned(tmp_path: Path) -> None:
    database, service, token, csrf, profile_text = _service(tmp_path)
    profile_id = UUID(profile_text)
    question = service.create_question(
        token,
        csrf,
        profile_id,
        text="What does the synthetic result mean?",
        priority="before_next_visit",
        due_date="2027-01-02",
        now=1_800_000_002,
    )
    followup = service.create_followup(
        token,
        csrf,
        profile_id,
        title="Call the synthetic clinic",
        due_date="2027-01-03",
        now=1_800_000_003,
    )
    decision = service.create_decision(
        token,
        csrf,
        profile_id,
        title="Use the synthetic specialist",
        rationale="Synthetic test rationale only.",
        decided_at=1_800_000_003,
        now=1_800_000_004,
    )
    completed = service.set_question_state(
        token,
        csrf,
        question.id,
        "completed",
        now=1_800_000_005,
    )
    completed_followup = service.set_followup_state(
        token,
        csrf,
        followup.id,
        "completed",
        now=1_800_000_006,
    )
    dashboard = service.dashboard(token, profile_id)
    brief = service.appointment_markdown(token, profile_id)

    assert dashboard.preferred_name == "Synthetic loved one"
    assert dashboard.questions == (completed,)
    assert dashboard.questions[0].priority == "before_next_visit"
    assert dashboard.questions[0].state == "completed"
    assert dashboard.followups == (completed_followup,)
    assert dashboard.decisions == (decision,)
    assert dashboard.what_we_know == ()
    assert dashboard.what_this_means == ()
    assert "Preparation aid only" in brief
    assert "No open questions recorded" in brief
    assert "No open next steps recorded" in brief
    assert "Use the synthetic specialist" in brief
    assert "Synthetic test rationale only" in brief

    with database.connect(read_only=True) as connection:
        revisions = connection.execute(
            "SELECT revision_no, state FROM question_revisions WHERE question_id = ? "
            "ORDER BY revision_no",
            (str(question.id),),
        ).fetchall()
        audit = verify_audit_chain(connection)

    assert [(row["revision_no"], row["state"]) for row in revisions] == [
        (1, "open"),
        (2, "completed"),
    ]
    assert audit.ok is True
