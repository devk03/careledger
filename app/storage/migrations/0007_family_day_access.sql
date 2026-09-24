-- DRAFT ONLY. Depends on unregistered 0006_sparse_care_days.sql.
-- Apply only to a fresh fictional database during review. Do not register
-- either migration for application startup until TypeScript authorization,
-- storage, backup/restore and cutover gates have passed.
-- TRUST BOUNDARY: dates, notes and identifiers remain plaintext on the trusted
-- family server. This is not the managed family-controlled E2EE schema.

ALTER TABLE users ADD COLUMN member_kind TEXT NOT NULL DEFAULT 'adult'
    CHECK (member_kind IN ('adult', 'child') AND (role != 'owner' OR member_kind = 'adult'));

ALTER TABLE invitations ADD COLUMN member_kind TEXT NOT NULL DEFAULT 'adult'
    CHECK (member_kind IN ('adult', 'child'));

CREATE TRIGGER users_member_kind_no_change
BEFORE UPDATE OF member_kind ON users
WHEN NEW.member_kind != OLD.member_kind
BEGIN
    SELECT RAISE(ABORT, 'member kind cannot be changed after provisioning');
END;

CREATE TRIGGER invitations_member_kind_no_change
BEFORE UPDATE OF member_kind ON invitations
WHEN NEW.member_kind != OLD.member_kind
BEGIN
    SELECT RAISE(ABORT, 'invitation member kind is immutable');
END;

-- Each tuple has an append-only sequence. The latest level is effective;
-- 'none' revokes it. A grant may predate the first populated day node.
CREATE TABLE day_access_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    care_day TEXT NOT NULL CHECK (
        length(care_day) = 10
        AND care_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(care_day) = care_day
    ),
    subject_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_no INTEGER NOT NULL CHECK (event_no > 0),
    level TEXT NOT NULL CHECK (level IN ('none', 'view', 'contribute', 'publish')),
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
    UNIQUE (care_profile_id, care_day, subject_user_id, event_no)
) STRICT;

CREATE INDEX day_access_events_latest
ON day_access_events (care_profile_id, care_day, subject_user_id, event_no DESC);

CREATE VIEW current_day_access AS
SELECT grant_event.care_profile_id, grant_event.care_day,
       grant_event.subject_user_id, grant_event.level, grant_event.event_no
FROM day_access_events AS grant_event
JOIN users AS subject ON subject.id = grant_event.subject_user_id
WHERE subject.status = 'active'
  AND grant_event.level != 'none'
  AND grant_event.event_no = (
      SELECT max(later.event_no) FROM day_access_events AS later
      WHERE later.care_profile_id = grant_event.care_profile_id
        AND later.care_day = grant_event.care_day
        AND later.subject_user_id = grant_event.subject_user_id
  );

CREATE TRIGGER day_access_events_scope_insert
BEFORE INSERT ON day_access_events
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS subject ON subject.id = NEW.subject_user_id
    JOIN users AS actor ON actor.id = NEW.actor_user_id
    WHERE profile.id = NEW.care_profile_id
      AND subject.household_id = profile.household_id
      AND actor.household_id = profile.household_id
      AND actor.role = 'owner' AND actor.member_kind = 'adult'
      AND actor.status = 'active' AND subject.status = 'active'
      AND (NEW.level != 'publish' OR subject.member_kind = 'adult')
) OR NEW.event_no != COALESCE((
    SELECT max(event_no) + 1 FROM day_access_events
    WHERE care_profile_id = NEW.care_profile_id AND care_day = NEW.care_day
      AND subject_user_id = NEW.subject_user_id
), 1)
BEGIN
    SELECT RAISE(ABORT, 'day grant scope, level or sequence is invalid');
END;

-- Allows a child to submit material for a new or uncertain day without
-- granting access to other days or authority to publish.
CREATE TABLE profile_intake_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    subject_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_no INTEGER NOT NULL CHECK (event_no > 0),
    allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
    UNIQUE (care_profile_id, subject_user_id, event_no)
) STRICT;

CREATE INDEX profile_intake_events_latest
ON profile_intake_events (care_profile_id, subject_user_id, event_no DESC);

CREATE VIEW current_profile_intake AS
SELECT grant_event.care_profile_id, grant_event.subject_user_id
FROM profile_intake_events AS grant_event
JOIN users AS subject ON subject.id = grant_event.subject_user_id
WHERE subject.status = 'active' AND grant_event.allowed = 1
  AND grant_event.event_no = (
      SELECT max(later.event_no) FROM profile_intake_events AS later
      WHERE later.care_profile_id = grant_event.care_profile_id
        AND later.subject_user_id = grant_event.subject_user_id
  );

CREATE TRIGGER profile_intake_events_scope_insert
BEFORE INSERT ON profile_intake_events
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS subject ON subject.id = NEW.subject_user_id
    JOIN users AS actor ON actor.id = NEW.actor_user_id
    WHERE profile.id = NEW.care_profile_id
      AND subject.household_id = profile.household_id
      AND actor.household_id = profile.household_id
      AND actor.role = 'owner' AND actor.member_kind = 'adult'
      AND actor.status = 'active' AND subject.status = 'active'
) OR NEW.event_no != COALESCE((
    SELECT max(event_no) + 1 FROM profile_intake_events
    WHERE care_profile_id = NEW.care_profile_id
      AND subject_user_id = NEW.subject_user_id
), 1)
BEGIN
    SELECT RAISE(ABORT, 'intake grant scope or sequence is invalid');
END;

-- Whole-source access is separate from day access because one original may
-- contain information about several days with different readers.
CREATE TABLE document_access_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    document_id TEXT NOT NULL,
    subject_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_no INTEGER NOT NULL CHECK (event_no > 0),
    allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
    FOREIGN KEY (document_id, care_profile_id)
        REFERENCES documents(id, care_profile_id) ON DELETE RESTRICT,
    UNIQUE (document_id, subject_user_id, event_no)
) STRICT;

CREATE INDEX document_access_events_latest
ON document_access_events (document_id, subject_user_id, event_no DESC);

CREATE VIEW current_document_access AS
SELECT grant_event.care_profile_id, grant_event.document_id,
       grant_event.subject_user_id
FROM document_access_events AS grant_event
JOIN users AS subject ON subject.id = grant_event.subject_user_id
WHERE subject.status = 'active' AND grant_event.allowed = 1
  AND grant_event.event_no = (
      SELECT max(later.event_no) FROM document_access_events AS later
      WHERE later.document_id = grant_event.document_id
        AND later.subject_user_id = grant_event.subject_user_id
  );

CREATE TRIGGER document_access_events_scope_insert
BEFORE INSERT ON document_access_events
WHEN NOT EXISTS (
    SELECT 1 FROM documents AS document
    JOIN care_profiles AS profile ON profile.id = document.care_profile_id
    JOIN users AS subject ON subject.id = NEW.subject_user_id
    JOIN users AS actor ON actor.id = NEW.actor_user_id
    WHERE document.id = NEW.document_id
      AND document.care_profile_id = NEW.care_profile_id
      AND subject.household_id = profile.household_id
      AND actor.household_id = profile.household_id
      AND actor.role = 'owner' AND actor.member_kind = 'adult'
      AND actor.status = 'active' AND subject.status = 'active'
) OR NEW.event_no != COALESCE((
    SELECT max(event_no) + 1 FROM document_access_events
    WHERE document_id = NEW.document_id AND subject_user_id = NEW.subject_user_id
), 1)
BEGIN
    SELECT RAISE(ABORT, 'source grant scope or sequence is invalid');
END;

CREATE TABLE day_nodes (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    care_day TEXT NOT NULL CHECK (
        length(care_day) = 10
        AND care_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(care_day) = care_day
    ),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE (care_profile_id, care_day)
) STRICT;

CREATE TRIGGER day_nodes_scope_insert
BEFORE INSERT ON day_nodes
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE profile.id = NEW.care_profile_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active' AND actor.member_kind = 'adult'
      AND (actor.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_day_access AS grant_row
          WHERE grant_row.care_profile_id = NEW.care_profile_id
            AND grant_row.care_day = NEW.care_day
            AND grant_row.subject_user_id = NEW.created_by
            AND grant_row.level = 'publish'
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'day node creator lacks publish authority');
END;

-- Entries form the complete published snapshot; originals are referenced,
-- never copied. The application must create header and entries atomically.
CREATE TABLE day_snapshots (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    day_node_id TEXT NOT NULL REFERENCES day_nodes(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    previous_snapshot_id TEXT REFERENCES day_snapshots(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    published_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    published_at INTEGER NOT NULL CHECK (published_at > 0),
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 2000),
    UNIQUE (day_node_id, revision_no)
) STRICT;

CREATE INDEX day_snapshots_latest
ON day_snapshots (day_node_id, revision_no DESC);

CREATE TRIGGER day_snapshots_scope_insert
BEFORE INSERT ON day_snapshots
WHEN NOT EXISTS (
    SELECT 1 FROM day_nodes AS node
    JOIN care_profiles AS profile ON profile.id = node.care_profile_id
    JOIN users AS actor ON actor.id = NEW.published_by
    WHERE node.id = NEW.day_node_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active' AND actor.member_kind = 'adult'
      AND (actor.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_day_access AS grant_row
          WHERE grant_row.care_profile_id = node.care_profile_id
            AND grant_row.care_day = node.care_day
            AND grant_row.subject_user_id = NEW.published_by
            AND grant_row.level = 'publish'
      ))
) OR NEW.revision_no != COALESCE((
    SELECT max(revision_no) + 1 FROM day_snapshots
    WHERE day_node_id = NEW.day_node_id
), 1) OR (
    (NEW.revision_no = 1 AND NEW.previous_snapshot_id IS NOT NULL)
    OR (NEW.revision_no > 1 AND NEW.previous_snapshot_id IS NOT (
        SELECT id FROM day_snapshots
        WHERE day_node_id = NEW.day_node_id
        ORDER BY revision_no DESC LIMIT 1
    ))
)
BEGIN
    SELECT RAISE(ABORT, 'snapshot scope or previous revision is invalid');
END;

CREATE TABLE day_snapshot_entries (
    snapshot_id TEXT NOT NULL REFERENCES day_snapshots(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    placement_revision_id TEXT REFERENCES document_day_placement_revisions(id) ON DELETE RESTRICT,
    note_revision_id TEXT REFERENCES family_note_revisions(id) ON DELETE RESTRICT,
    claim_revision_id TEXT REFERENCES evidence_claim_revisions(id) ON DELETE RESTRICT,
    PRIMARY KEY (snapshot_id, position),
    CHECK (
        (placement_revision_id IS NOT NULL)
        + (note_revision_id IS NOT NULL)
        + (claim_revision_id IS NOT NULL) = 1
    )
) STRICT;

CREATE TRIGGER day_snapshot_entries_scope_insert
BEFORE INSERT ON day_snapshot_entries
WHEN NEW.position != COALESCE((
    SELECT max(position) + 1 FROM day_snapshot_entries
    WHERE snapshot_id = NEW.snapshot_id
), 0) OR (NEW.placement_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM day_snapshots AS snapshot
    JOIN day_nodes AS node ON node.id = snapshot.day_node_id
    JOIN current_accepted_document_days AS placed
        ON placed.revision_id = NEW.placement_revision_id
    WHERE snapshot.id = NEW.snapshot_id
      AND placed.care_profile_id = node.care_profile_id
      AND placed.care_day = node.care_day
)) OR (NEW.note_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM day_snapshots AS snapshot
    JOIN day_nodes AS node ON node.id = snapshot.day_node_id
    JOIN current_accepted_family_notes AS note
        ON note.revision_id = NEW.note_revision_id
    WHERE snapshot.id = NEW.snapshot_id
      AND note.care_profile_id = node.care_profile_id
      AND note.care_day = node.care_day
)) OR (NEW.claim_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM day_snapshots AS snapshot
    JOIN day_nodes AS node ON node.id = snapshot.day_node_id
    JOIN evidence_claim_revisions AS revision
        ON revision.id = NEW.claim_revision_id
    JOIN evidence_claims AS claim ON claim.id = revision.claim_id
    WHERE snapshot.id = NEW.snapshot_id
      AND claim.care_profile_id = node.care_profile_id
      AND revision.review_state = 'accepted'
      AND revision.event_date = node.care_day
))
BEGIN
    SELECT RAISE(ABORT, 'snapshot entry order or accepted source scope is invalid for this day');
END;

-- The queue references proposals, not copies of medical content. A review
-- request exists once per child-authored revision and remains immutable.
CREATE TABLE child_review_requests (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    target_care_day TEXT CHECK (
        target_care_day IS NULL OR (
            length(target_care_day) = 10
            AND target_care_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND date(target_care_day) = target_care_day
        )
    ),
    proposed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    placement_revision_id TEXT UNIQUE REFERENCES document_day_placement_revisions(id) ON DELETE RESTRICT,
    note_revision_id TEXT UNIQUE REFERENCES family_note_revisions(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK ((placement_revision_id IS NOT NULL) + (note_revision_id IS NOT NULL) = 1),
    CHECK (placement_revision_id IS NULL OR target_care_day IS NOT NULL)
) STRICT;

CREATE INDEX child_review_requests_profile_day
ON child_review_requests (care_profile_id, target_care_day, created_at);

CREATE TRIGGER child_review_requests_scope_insert
BEFORE INSERT ON child_review_requests
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS child ON child.id = NEW.proposed_by
    WHERE profile.id = NEW.care_profile_id
      AND child.household_id = profile.household_id
      AND child.status = 'active' AND child.member_kind = 'child'
) OR (NEW.placement_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_day_placement_revisions AS revision
    JOIN document_day_placements AS placement ON placement.id = revision.placement_id
    WHERE revision.id = NEW.placement_revision_id
      AND revision.created_by = NEW.proposed_by
      AND placement.care_profile_id = NEW.care_profile_id
      AND revision.care_day = NEW.target_care_day
      AND NOT EXISTS (
          SELECT 1 FROM document_day_placement_reviews AS review
          WHERE review.revision_id = revision.id
      )
)) OR (NEW.note_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM family_note_revisions AS revision
    JOIN family_notes AS note ON note.id = revision.note_id
    WHERE revision.id = NEW.note_revision_id
      AND revision.created_by = NEW.proposed_by
      AND note.care_profile_id = NEW.care_profile_id
      AND revision.care_day IS NEW.target_care_day
      AND NOT EXISTS (
          SELECT 1 FROM family_note_reviews AS review
          WHERE review.revision_id = revision.id
      )
))
BEGIN
    SELECT RAISE(ABORT, 'child review request is not a pending in-scope child proposal');
END;

CREATE TABLE review_outbox_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_request_id TEXT NOT NULL REFERENCES child_review_requests(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('requested', 'resolved')),
    occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
    UNIQUE (review_request_id, kind)
) STRICT;

CREATE TRIGGER review_outbox_events_consistency_insert
BEFORE INSERT ON review_outbox_events
WHEN (NEW.kind = 'requested' AND NOT EXISTS (
    SELECT 1 FROM child_review_requests AS request
    WHERE request.id = NEW.review_request_id
      AND request.created_at = NEW.occurred_at
)) OR (NEW.kind = 'resolved' AND NOT EXISTS (
    SELECT 1 FROM child_review_requests AS request
    LEFT JOIN document_day_placement_reviews AS placement_review
        ON placement_review.revision_id = request.placement_revision_id
    LEFT JOIN family_note_reviews AS note_review
        ON note_review.revision_id = request.note_revision_id
    WHERE request.id = NEW.review_request_id
      AND NEW.occurred_at = COALESCE(placement_review.decided_at, note_review.decided_at)
))
BEGIN
    SELECT RAISE(ABORT, 'review outbox event does not match proposal state');
END;

CREATE TRIGGER child_review_requests_requested_event
AFTER INSERT ON child_review_requests
BEGIN
    INSERT INTO review_outbox_events (review_request_id, kind, occurred_at)
    VALUES (NEW.id, 'requested', NEW.created_at);
END;

CREATE TRIGGER child_placement_reviews_resolved_event
AFTER INSERT ON document_day_placement_reviews
WHEN EXISTS (
    SELECT 1 FROM child_review_requests
    WHERE placement_revision_id = NEW.revision_id
)
BEGIN
    INSERT INTO review_outbox_events (review_request_id, kind, occurred_at)
    SELECT id, 'resolved', NEW.decided_at FROM child_review_requests
    WHERE placement_revision_id = NEW.revision_id;
END;

CREATE TRIGGER child_note_reviews_resolved_event
AFTER INSERT ON family_note_reviews
WHEN EXISTS (
    SELECT 1 FROM child_review_requests
    WHERE note_revision_id = NEW.revision_id
)
BEGIN
    INSERT INTO review_outbox_events (review_request_id, kind, occurred_at)
    SELECT id, 'resolved', NEW.decided_at FROM child_review_requests
    WHERE note_revision_id = NEW.revision_id;
END;

-- This view is NOT an authorization boundary. Callers must filter by active
-- adult reviewer and current day-publish or profile-level review authority.
CREATE VIEW pending_child_reviews AS
SELECT request.id, request.care_profile_id, request.target_care_day,
       request.proposed_by, request.created_at
FROM child_review_requests AS request
WHERE (request.placement_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_day_placement_reviews AS review
    WHERE review.revision_id = request.placement_revision_id
)) OR (request.note_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM family_note_reviews AS review
    WHERE review.revision_id = request.note_revision_id
));

-- Additional guards on the earlier 0006 tables. Its household check alone
-- cannot grant a member access to submit or an adult authority to publish.
CREATE TRIGGER placements_creation_access_insert
BEFORE INSERT ON document_day_placements
WHEN NOT EXISTS (
    SELECT 1 FROM documents AS document
    JOIN care_profiles AS profile ON profile.id = document.care_profile_id
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE document.id = NEW.document_id
      AND document.care_profile_id = NEW.care_profile_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
      AND (actor.role = 'owner' OR (
          document.uploaded_by = NEW.created_by
          AND EXISTS (
              SELECT 1 FROM current_profile_intake AS intake
              WHERE intake.care_profile_id = NEW.care_profile_id
                AND intake.subject_user_id = NEW.created_by
          )
      ) OR EXISTS (
          SELECT 1 FROM current_document_access AS grant_row
          WHERE grant_row.document_id = NEW.document_id
            AND grant_row.subject_user_id = NEW.created_by
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'placement creator lacks source or own-intake access');
END;

CREATE TRIGGER family_notes_creation_access_insert
BEFORE INSERT ON family_notes
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE profile.id = NEW.care_profile_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
      AND (actor.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_profile_intake AS intake
          WHERE intake.care_profile_id = NEW.care_profile_id
            AND intake.subject_user_id = NEW.created_by
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'note creator lacks intake access');
END;

CREATE TRIGGER placement_revisions_day_grant_insert
BEFORE INSERT ON document_day_placement_revisions
WHEN NOT EXISTS (
    SELECT 1 FROM document_day_placements AS placement
    JOIN care_profiles AS profile ON profile.id = placement.care_profile_id
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE placement.id = NEW.placement_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
      AND (actor.member_kind = 'adult' OR placement.created_by = NEW.created_by)
      AND (actor.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_day_access AS grant_row
          WHERE grant_row.care_profile_id = placement.care_profile_id
            AND grant_row.care_day = NEW.care_day
            AND grant_row.subject_user_id = NEW.created_by
            AND grant_row.level IN ('contribute', 'publish')
      ) OR EXISTS (
          SELECT 1 FROM current_profile_intake AS intake
          WHERE intake.care_profile_id = placement.care_profile_id
            AND intake.subject_user_id = NEW.created_by
            AND placement.created_by = NEW.created_by
            AND NEW.revision_no = 1
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'placement contributor lacks day or intake grant');
END;

CREATE TRIGGER note_revisions_day_grant_insert
BEFORE INSERT ON family_note_revisions
WHEN NOT EXISTS (
    SELECT 1 FROM family_notes AS note
    JOIN care_profiles AS profile ON profile.id = note.care_profile_id
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE note.id = NEW.note_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
      AND (actor.member_kind = 'adult' OR note.created_by = NEW.created_by)
      AND (actor.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_day_access AS grant_row
          WHERE grant_row.care_profile_id = note.care_profile_id
            AND grant_row.care_day = NEW.care_day
            AND grant_row.subject_user_id = NEW.created_by
            AND grant_row.level IN ('contribute', 'publish')
      ) OR EXISTS (
          SELECT 1 FROM current_profile_intake AS intake
          WHERE intake.care_profile_id = note.care_profile_id
            AND intake.subject_user_id = NEW.created_by
            AND note.created_by = NEW.created_by
            AND NEW.revision_no = 1
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'note contributor lacks day or intake grant');
END;

CREATE TRIGGER placement_reviews_adult_publish_insert
BEFORE INSERT ON document_day_placement_reviews
WHEN NOT EXISTS (
    SELECT 1 FROM document_day_placement_revisions AS revision
    JOIN document_day_placements AS placement ON placement.id = revision.placement_id
    JOIN care_profiles AS profile ON profile.id = placement.care_profile_id
    JOIN users AS reviewer ON reviewer.id = NEW.reviewer_id
    WHERE revision.id = NEW.revision_id
      AND reviewer.household_id = profile.household_id
      AND reviewer.status = 'active' AND reviewer.member_kind = 'adult'
      AND (reviewer.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_day_access AS grant_row
          WHERE grant_row.care_profile_id = placement.care_profile_id
            AND grant_row.care_day = revision.care_day
            AND grant_row.subject_user_id = NEW.reviewer_id
            AND grant_row.level = 'publish'
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'placement reviewer must be an authorized adult publisher');
END;

CREATE TRIGGER note_reviews_adult_publish_insert
BEFORE INSERT ON family_note_reviews
WHEN NOT EXISTS (
    SELECT 1 FROM family_note_revisions AS revision
    JOIN family_notes AS note ON note.id = revision.note_id
    JOIN care_profiles AS profile ON profile.id = note.care_profile_id
    JOIN users AS reviewer ON reviewer.id = NEW.reviewer_id
    WHERE revision.id = NEW.revision_id
      AND reviewer.household_id = profile.household_id
      AND reviewer.status = 'active' AND reviewer.member_kind = 'adult'
      AND (reviewer.role = 'owner' OR EXISTS (
          SELECT 1 FROM current_day_access AS grant_row
          WHERE grant_row.care_profile_id = note.care_profile_id
            AND grant_row.care_day = revision.care_day
            AND grant_row.subject_user_id = NEW.reviewer_id
            AND grant_row.level = 'publish'
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'note reviewer must be an authorized adult publisher');
END;

CREATE TRIGGER day_access_events_no_update BEFORE UPDATE ON day_access_events
BEGIN SELECT RAISE(ABORT, 'day grant events are immutable'); END;
CREATE TRIGGER day_access_events_no_delete BEFORE DELETE ON day_access_events
BEGIN SELECT RAISE(ABORT, 'day grant events cannot be deleted'); END;
CREATE TRIGGER profile_intake_events_no_update BEFORE UPDATE ON profile_intake_events
BEGIN SELECT RAISE(ABORT, 'intake grant events are immutable'); END;
CREATE TRIGGER profile_intake_events_no_delete BEFORE DELETE ON profile_intake_events
BEGIN SELECT RAISE(ABORT, 'intake grant events cannot be deleted'); END;
CREATE TRIGGER document_access_events_no_update BEFORE UPDATE ON document_access_events
BEGIN SELECT RAISE(ABORT, 'source grant events are immutable'); END;
CREATE TRIGGER document_access_events_no_delete BEFORE DELETE ON document_access_events
BEGIN SELECT RAISE(ABORT, 'source grant events cannot be deleted'); END;
CREATE TRIGGER day_nodes_no_update BEFORE UPDATE ON day_nodes
BEGIN SELECT RAISE(ABORT, 'day nodes are immutable'); END;
CREATE TRIGGER day_nodes_no_delete BEFORE DELETE ON day_nodes
BEGIN SELECT RAISE(ABORT, 'day nodes cannot be deleted'); END;
CREATE TRIGGER day_snapshots_no_update BEFORE UPDATE ON day_snapshots
BEGIN SELECT RAISE(ABORT, 'day snapshots are immutable'); END;
CREATE TRIGGER day_snapshots_no_delete BEFORE DELETE ON day_snapshots
BEGIN SELECT RAISE(ABORT, 'day snapshots cannot be deleted'); END;
CREATE TRIGGER day_snapshot_entries_no_update BEFORE UPDATE ON day_snapshot_entries
BEGIN SELECT RAISE(ABORT, 'snapshot entries are immutable'); END;
CREATE TRIGGER day_snapshot_entries_no_delete BEFORE DELETE ON day_snapshot_entries
BEGIN SELECT RAISE(ABORT, 'snapshot entries cannot be deleted'); END;
CREATE TRIGGER child_review_requests_no_update BEFORE UPDATE ON child_review_requests
BEGIN SELECT RAISE(ABORT, 'child review requests are immutable'); END;
CREATE TRIGGER child_review_requests_no_delete BEFORE DELETE ON child_review_requests
BEGIN SELECT RAISE(ABORT, 'child review requests cannot be deleted'); END;
CREATE TRIGGER review_outbox_events_no_update BEFORE UPDATE ON review_outbox_events
BEGIN SELECT RAISE(ABORT, 'review outbox events are immutable'); END;
CREATE TRIGGER review_outbox_events_no_delete BEFORE DELETE ON review_outbox_events
BEGIN SELECT RAISE(ABORT, 'review outbox events cannot be deleted'); END;
