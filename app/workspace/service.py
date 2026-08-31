import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import cast
from uuid import UUID, uuid4

from app.security.auth import AuthService, SessionRecord, append_audit_event
from app.storage.database import Database

_PRIORITIES = {"before_next_visit", "at_next_visit", "when_possible"}
_WORKFLOW_STATES = {"open", "waiting", "completed", "cancelled"}


class WorkspaceErrorCode(StrEnum):
    PROFILE_NOT_FOUND = "PROFILE_NOT_FOUND"
    ITEM_NOT_FOUND = "ITEM_NOT_FOUND"
    INVALID_INPUT = "INVALID_INPUT"


class WorkspaceError(RuntimeError):
    def __init__(self, code: WorkspaceErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class SourcePointer:
    document_id: UUID
    page_number: int


@dataclass(frozen=True)
class SummaryClaim:
    claim_id: UUID
    statement: str
    plain_language: str | None
    kind: str
    event_date: str | None
    sources: tuple[SourcePointer, ...]


@dataclass(frozen=True)
class QuestionRecord:
    id: UUID
    text: str
    priority: str
    state: str
    due_date: str | None


@dataclass(frozen=True)
class FollowupRecord:
    id: UUID
    title: str
    source: str
    state: str
    due_date: str | None


@dataclass(frozen=True)
class DecisionRecord:
    id: UUID
    title: str
    decided_at: int
    rationale: str | None


@dataclass(frozen=True)
class CareDashboard:
    profile_id: UUID
    preferred_name: str
    what_we_know: tuple[SummaryClaim, ...]
    what_this_means: tuple[SummaryClaim, ...]
    what_remains_unknown: tuple[SummaryClaim, ...]
    timeline: tuple[SummaryClaim, ...]
    questions: tuple[QuestionRecord, ...]
    followups: tuple[FollowupRecord, ...]
    decisions: tuple[DecisionRecord, ...]


class CareWorkspaceService:
    def __init__(self, database: Database, auth: AuthService) -> None:
        self._database = database
        self._auth = auth

    def dashboard(self, plaintext_token: str, profile_id: UUID) -> CareDashboard:
        session = self._auth.session(plaintext_token)
        with self._database.connect(read_only=True) as connection:
            profile = _profile(connection, profile_id, session.household_id)
            claims = _claims(connection, profile_id)
            questions = _questions(connection, profile_id)
            followups = _followups(connection, profile_id)
            decisions = _decisions(connection, profile_id)
        accepted = tuple(claim for claim in claims if claim.kind != "unconfirmed_recollection")
        return CareDashboard(
            profile_id=profile_id,
            preferred_name=profile["preferred_name"],
            what_we_know=tuple(
                claim
                for claim in accepted
                if claim.kind in {"source_documented_fact", "user_attested_confirmed_fact"}
            ),
            what_this_means=tuple(
                claim for claim in accepted if claim.kind == "clinician_interpretation"
            ),
            what_remains_unknown=tuple(
                claim for claim in claims if claim.kind == "unconfirmed_recollection"
            ),
            timeline=tuple(
                sorted(
                    (claim for claim in accepted if claim.event_date),
                    key=lambda claim: claim.event_date or "",
                    reverse=True,
                )
            ),
            questions=questions,
            followups=followups,
            decisions=decisions,
        )

    def appointment_markdown(self, plaintext_token: str, profile_id: UUID) -> str:
        dashboard = self.dashboard(plaintext_token, profile_id)
        lines = [
            f"# Appointment brief — {_markdown_escape(dashboard.preferred_name)}",
            "",
            f"Prepared: {date.today().isoformat()}",
            "",
            "> Preparation aid only — not medical advice.",
            "",
        ]
        _append_claims(lines, "What we know", dashboard.what_we_know)
        _append_claims(lines, "What the records may mean", dashboard.what_this_means)
        _append_claims(lines, "What remains unknown", dashboard.what_remains_unknown)
        lines.extend(["## Questions to ask", ""])
        open_questions = tuple(
            item for item in dashboard.questions if item.state not in {"completed", "cancelled"}
        )
        if not open_questions:
            lines.append("- No open questions recorded.")
        for question_item in open_questions:
            due = f"; due {question_item.due_date}" if question_item.due_date else ""
            lines.append(
                f"- {_markdown_escape(question_item.text)} ({question_item.priority}{due})"
            )
        lines.extend(["", "## What to do next", ""])
        open_followups = tuple(
            item for item in dashboard.followups if item.state not in {"completed", "cancelled"}
        )
        if not open_followups:
            lines.append("- No open next steps recorded.")
        for followup_item in open_followups:
            due = f"; due {followup_item.due_date}" if followup_item.due_date else ""
            lines.append(
                f"- {_markdown_escape(followup_item.title)} ({followup_item.source}{due})"
            )
        lines.extend(["", "## Decisions made", ""])
        if not dashboard.decisions:
            lines.append("- No decisions recorded.")
        for decision_item in dashboard.decisions:
            rationale = (
                f" — {_markdown_escape(decision_item.rationale)}"
                if decision_item.rationale is not None
                else ""
            )
            decided = datetime.fromtimestamp(decision_item.decided_at, tz=UTC).date().isoformat()
            lines.append(f"- {decided}: {_markdown_escape(decision_item.title)}{rationale}")
        lines.append("")
        return "\n".join(lines)

    def create_question(
        self,
        plaintext_token: str,
        csrf_token: str,
        profile_id: UUID,
        *,
        text: str,
        priority: str,
        due_date: str | None,
        now: int | None = None,
    ) -> QuestionRecord:
        timestamp = now or _now_epoch()
        normalized = _text(text, maximum=500)
        if priority not in _PRIORITIES:
            raise WorkspaceError(WorkspaceErrorCode.INVALID_INPUT)
        normalized_due = _date_or_none(due_date)
        question_id = uuid4()
        revision_id = uuid4()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection, plaintext_token, csrf_token, now=timestamp
            )
            _profile(connection, profile_id, session.household_id)
            connection.execute(
                "INSERT INTO questions (id, care_profile_id, created_at) VALUES (?, ?, ?)",
                (str(question_id), str(profile_id), timestamp),
            )
            connection.execute(
                "INSERT INTO question_revisions "
                "(id, question_id, revision_no, text, priority, state, owner_id, due_date, "
                "answer, answer_source_count, created_by, created_at) "
                "VALUES (?, ?, 1, ?, ?, 'open', ?, ?, NULL, 0, ?, ?)",
                (
                    str(revision_id),
                    str(question_id),
                    normalized,
                    priority,
                    str(session.user.id),
                    normalized_due,
                    str(session.user.id),
                    timestamp,
                ),
            )
            _audit(connection, session, "question_created", question_id, timestamp)
        return QuestionRecord(question_id, normalized, priority, "open", normalized_due)

    def set_question_state(
        self,
        plaintext_token: str,
        csrf_token: str,
        question_id: UUID,
        state: str,
        *,
        now: int | None = None,
    ) -> QuestionRecord:
        if state not in _WORKFLOW_STATES:
            raise WorkspaceError(WorkspaceErrorCode.INVALID_INPUT)
        timestamp = now or _now_epoch()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection, plaintext_token, csrf_token, now=timestamp
            )
            current = _current_question(connection, question_id, session.household_id)
            revision_id = uuid4()
            connection.execute(
                "INSERT INTO question_revisions "
                "(id, question_id, revision_no, text, priority, state, owner_id, due_date, "
                "answer, answer_source_count, created_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (
                    str(revision_id),
                    str(question_id),
                    int(current["revision_no"]) + 1,
                    current["text"],
                    current["priority"],
                    state,
                    current["owner_id"],
                    current["due_date"],
                    current["answer"],
                    str(session.user.id),
                    timestamp,
                ),
            )
            _audit(connection, session, "question_state_changed", question_id, timestamp)
        return QuestionRecord(
            question_id,
            current["text"],
            current["priority"],
            state,
            current["due_date"],
        )

    def create_followup(
        self,
        plaintext_token: str,
        csrf_token: str,
        profile_id: UUID,
        *,
        title: str,
        due_date: str | None,
        now: int | None = None,
    ) -> FollowupRecord:
        timestamp = now or _now_epoch()
        normalized = _text(title, maximum=500)
        normalized_due = _date_or_none(due_date)
        followup_id = uuid4()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection, plaintext_token, csrf_token, now=timestamp
            )
            _profile(connection, profile_id, session.household_id)
            connection.execute(
                "INSERT INTO followups (id, care_profile_id, created_at) VALUES (?, ?, ?)",
                (str(followup_id), str(profile_id), timestamp),
            )
            connection.execute(
                "INSERT INTO followup_revisions "
                "(id, followup_id, revision_no, title, source, state, owner_id, due_date, "
                "source_count, created_by, created_at) "
                "VALUES (?, ?, 1, ?, 'caregiver_task', 'open', ?, ?, 0, ?, ?)",
                (
                    str(uuid4()),
                    str(followup_id),
                    normalized,
                    str(session.user.id),
                    normalized_due,
                    str(session.user.id),
                    timestamp,
                ),
            )
            _audit(connection, session, "followup_created", followup_id, timestamp)
        return FollowupRecord(followup_id, normalized, "caregiver_task", "open", normalized_due)

    def create_decision(
        self,
        plaintext_token: str,
        csrf_token: str,
        profile_id: UUID,
        *,
        title: str,
        rationale: str | None,
        decided_at: int,
        now: int | None = None,
    ) -> DecisionRecord:
        timestamp = now or _now_epoch()
        normalized = _text(title, maximum=500)
        normalized_rationale = _optional_text(rationale, maximum=2_000)
        if decided_at < 1:
            raise WorkspaceError(WorkspaceErrorCode.INVALID_INPUT)
        decision_id = uuid4()
        revision_id = uuid4()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection, plaintext_token, csrf_token, now=timestamp
            )
            _profile(connection, profile_id, session.household_id)
            connection.execute(
                "INSERT INTO decisions (id, care_profile_id, created_at) VALUES (?, ?, ?)",
                (str(decision_id), str(profile_id), timestamp),
            )
            connection.execute(
                "INSERT INTO decision_makers (decision_revision_id, position, user_id) "
                "VALUES (?, 0, ?)",
                (str(revision_id), str(session.user.id)),
            )
            connection.execute(
                "INSERT INTO decision_revisions "
                "(id, decision_id, revision_no, title, decided_at, rationale, maker_count, "
                "source_count, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, 1, 0, ?, ?)",
                (
                    str(revision_id),
                    str(decision_id),
                    normalized,
                    decided_at,
                    normalized_rationale,
                    str(session.user.id),
                    timestamp,
                ),
            )
            _audit(connection, session, "decision_recorded", decision_id, timestamp)
        return DecisionRecord(decision_id, normalized, decided_at, normalized_rationale)

    def set_followup_state(
        self,
        plaintext_token: str,
        csrf_token: str,
        followup_id: UUID,
        state: str,
        *,
        now: int | None = None,
    ) -> FollowupRecord:
        if state not in _WORKFLOW_STATES:
            raise WorkspaceError(WorkspaceErrorCode.INVALID_INPUT)
        timestamp = now or _now_epoch()
        with self._database.transaction() as connection:
            session = self._auth.authorize_mutation(
                connection, plaintext_token, csrf_token, now=timestamp
            )
            current = _current_followup(connection, followup_id, session.household_id)
            connection.execute(
                "INSERT INTO followup_revisions "
                "(id, followup_id, revision_no, title, source, state, owner_id, due_date, "
                "source_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (
                    str(uuid4()),
                    str(followup_id),
                    int(current["revision_no"]) + 1,
                    current["title"],
                    current["source"],
                    state,
                    current["owner_id"],
                    current["due_date"],
                    str(session.user.id),
                    timestamp,
                ),
            )
            _audit(connection, session, "followup_state_changed", followup_id, timestamp)
        return FollowupRecord(
            followup_id,
            current["title"],
            current["source"],
            state,
            current["due_date"],
        )


def _profile(
    connection: sqlite3.Connection,
    profile_id: UUID,
    household_id: UUID,
) -> sqlite3.Row:
    row = connection.execute(
        "SELECT id, preferred_name FROM care_profiles WHERE id = ? AND household_id = ? "
        "AND archived_at IS NULL",
        (str(profile_id), str(household_id)),
    ).fetchone()
    if row is None:
        raise WorkspaceError(WorkspaceErrorCode.PROFILE_NOT_FOUND)
    return cast(sqlite3.Row, row)


def _claims(connection: sqlite3.Connection, profile_id: UUID) -> tuple[SummaryClaim, ...]:
    rows = connection.execute(
        "SELECT revision.id, revision.claim_id, revision.statement, revision.plain_language, "
        "revision.kind, revision.event_date FROM current_evidence_claim_revisions AS revision "
        "JOIN evidence_claims ON evidence_claims.id = revision.claim_id "
        "WHERE evidence_claims.care_profile_id = ? AND revision.review_state = 'accepted' "
        "ORDER BY revision.event_date DESC, revision.created_at DESC",
        (str(profile_id),),
    ).fetchall()
    result: list[SummaryClaim] = []
    for row in rows:
        citations = connection.execute(
            "SELECT document_id, page_number FROM citations WHERE claim_revision_id = ? "
            "ORDER BY position",
            (row["id"],),
        ).fetchall()
        result.append(
            SummaryClaim(
                claim_id=UUID(row["claim_id"]),
                statement=row["statement"],
                plain_language=row["plain_language"],
                kind=row["kind"],
                event_date=row["event_date"],
                sources=tuple(
                    SourcePointer(UUID(citation["document_id"]), int(citation["page_number"]))
                    for citation in citations
                ),
            )
        )
    return tuple(result)


def _questions(connection: sqlite3.Connection, profile_id: UUID) -> tuple[QuestionRecord, ...]:
    rows = connection.execute(
        "SELECT questions.id, revision.text, revision.priority, revision.state, revision.due_date "
        "FROM questions JOIN question_revisions AS revision ON revision.question_id = questions.id "
        "WHERE questions.care_profile_id = ? AND revision.revision_no = ("
        "SELECT MAX(candidate.revision_no) FROM question_revisions AS candidate "
        "WHERE candidate.question_id = questions.id) "
        "ORDER BY CASE revision.priority WHEN 'before_next_visit' THEN 0 "
        "WHEN 'at_next_visit' THEN 1 ELSE 2 END, revision.created_at",
        (str(profile_id),),
    ).fetchall()
    return tuple(
        QuestionRecord(
            UUID(row["id"]), row["text"], row["priority"], row["state"], row["due_date"]
        )
        for row in rows
    )


def _followups(connection: sqlite3.Connection, profile_id: UUID) -> tuple[FollowupRecord, ...]:
    rows = connection.execute(
        "SELECT followups.id, revision.title, revision.source, revision.state, revision.due_date "
        "FROM followups JOIN followup_revisions AS revision "
        "ON revision.followup_id = followups.id WHERE followups.care_profile_id = ? "
        "AND revision.revision_no = (SELECT MAX(candidate.revision_no) "
        "FROM followup_revisions AS candidate WHERE candidate.followup_id = followups.id) "
        "ORDER BY revision.created_at",
        (str(profile_id),),
    ).fetchall()
    return tuple(
        FollowupRecord(
            UUID(row["id"]), row["title"], row["source"], row["state"], row["due_date"]
        )
        for row in rows
    )


def _decisions(connection: sqlite3.Connection, profile_id: UUID) -> tuple[DecisionRecord, ...]:
    rows = connection.execute(
        "SELECT decisions.id, revision.title, revision.decided_at, revision.rationale "
        "FROM decisions JOIN decision_revisions AS revision "
        "ON revision.decision_id = decisions.id WHERE decisions.care_profile_id = ? "
        "AND revision.revision_no = (SELECT MAX(candidate.revision_no) "
        "FROM decision_revisions AS candidate WHERE candidate.decision_id = decisions.id) "
        "ORDER BY revision.decided_at DESC",
        (str(profile_id),),
    ).fetchall()
    return tuple(
        DecisionRecord(UUID(row["id"]), row["title"], int(row["decided_at"]), row["rationale"])
        for row in rows
    )


def _current_question(
    connection: sqlite3.Connection,
    question_id: UUID,
    household_id: UUID,
) -> sqlite3.Row:
    row = connection.execute(
        "SELECT revision.* FROM question_revisions AS revision "
        "JOIN questions ON questions.id = revision.question_id "
        "JOIN care_profiles ON care_profiles.id = questions.care_profile_id "
        "WHERE questions.id = ? AND care_profiles.household_id = ? "
        "ORDER BY revision.revision_no DESC LIMIT 1",
        (str(question_id), str(household_id)),
    ).fetchone()
    if row is None:
        raise WorkspaceError(WorkspaceErrorCode.ITEM_NOT_FOUND)
    return cast(sqlite3.Row, row)


def _current_followup(
    connection: sqlite3.Connection,
    followup_id: UUID,
    household_id: UUID,
) -> sqlite3.Row:
    row = connection.execute(
        "SELECT revision.* FROM followup_revisions AS revision "
        "JOIN followups ON followups.id = revision.followup_id "
        "JOIN care_profiles ON care_profiles.id = followups.care_profile_id "
        "WHERE followups.id = ? AND care_profiles.household_id = ? "
        "ORDER BY revision.revision_no DESC LIMIT 1",
        (str(followup_id), str(household_id)),
    ).fetchone()
    if row is None:
        raise WorkspaceError(WorkspaceErrorCode.ITEM_NOT_FOUND)
    return cast(sqlite3.Row, row)


def _text(value: str, *, maximum: int) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > maximum or "\x00" in normalized:
        raise WorkspaceError(WorkspaceErrorCode.INVALID_INPUT)
    return normalized


def _optional_text(value: str | None, *, maximum: int) -> str | None:
    return _text(value, maximum=maximum) if value is not None else None


def _date_or_none(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise WorkspaceError(WorkspaceErrorCode.INVALID_INPUT) from error


def _audit(
    connection: sqlite3.Connection,
    session: SessionRecord,
    action: str,
    entity_id: UUID,
    now: int,
) -> None:
    append_audit_event(
        connection,
        household_id=str(session.household_id),
        actor_user_id=str(session.user.id),
        action=action,
        entity_kind="care_workflow",
        entity_id=str(entity_id),
        outcome="success",
        occurred_at=now,
    )


def _now_epoch() -> int:
    return int(datetime.now(UTC).timestamp())


def _append_claims(lines: list[str], heading: str, claims: tuple[SummaryClaim, ...]) -> None:
    lines.extend([f"## {heading}", ""])
    if not claims:
        lines.append("- Nothing recorded yet.")
    for claim in claims:
        explanation = (
            f" — {_markdown_escape(claim.plain_language)}"
            if claim.plain_language is not None
            else ""
        )
        lines.append(f"- {_markdown_escape(claim.statement)}{explanation}  ")
        if claim.sources:
            sources = "; ".join(
                f"document {source.document_id}, page {source.page_number}"
                for source in claim.sources
            )
        else:
            sources = "family-confirmed update"
        lines.append(f"  Source: {sources}")
    lines.append("")


def _markdown_escape(value: str) -> str:
    one_line = re.sub(r"\s+", " ", value).strip()
    return re.sub(r"([\\`*_{}\[\]()#+.!|>-])", r"\\\1", one_line)
