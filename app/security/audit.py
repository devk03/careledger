import hashlib
import json
import sqlite3
from dataclasses import dataclass


@dataclass(frozen=True)
class AuditChainReport:
    ok: bool
    total_events: int
    verified_through_sequence: int | None
    error_code: str | None = None


def event_hash_v1(
    *,
    event_id: str,
    household_id: str,
    actor_user_id: str | None,
    action: str,
    entity_kind: str,
    entity_id: str | None,
    outcome: str,
    occurred_at: int,
    previous_hash: str | None,
) -> str:
    """Hash the stable v1 audit fields used by every released CareLedger event."""
    canonical = json.dumps(
        {
            "action": action,
            "actor_user_id": actor_user_id,
            "entity_id": entity_id,
            "entity_kind": entity_kind,
            "household_id": household_id,
            "id": event_id,
            "occurred_at": occurred_at,
            "outcome": outcome,
            "previous_hash": previous_hash,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def verify_audit_chain(connection: sqlite3.Connection) -> AuditChainReport:
    rows = connection.execute(
        "SELECT sequence, id, household_id, actor_user_id, action, entity_kind, entity_id, "
        "outcome, occurred_at, previous_hash, event_hash "
        "FROM audit_events ORDER BY sequence"
    ).fetchall()
    previous_hash: str | None = None
    verified_sequence: int | None = None
    for row in rows:
        sequence = int(row["sequence"])
        if row["previous_hash"] != previous_hash:
            return AuditChainReport(
                ok=False,
                total_events=len(rows),
                verified_through_sequence=verified_sequence,
                error_code="PREVIOUS_HASH_MISMATCH",
            )
        expected_hash = event_hash_v1(
            event_id=row["id"],
            household_id=row["household_id"],
            actor_user_id=row["actor_user_id"],
            action=row["action"],
            entity_kind=row["entity_kind"],
            entity_id=row["entity_id"],
            outcome=row["outcome"],
            occurred_at=int(row["occurred_at"]),
            previous_hash=previous_hash,
        )
        if row["event_hash"] != expected_hash:
            return AuditChainReport(
                ok=False,
                total_events=len(rows),
                verified_through_sequence=verified_sequence,
                error_code="EVENT_HASH_MISMATCH",
            )
        previous_hash = expected_hash
        verified_sequence = sequence
    return AuditChainReport(
        ok=True,
        total_events=len(rows),
        verified_through_sequence=verified_sequence,
    )
