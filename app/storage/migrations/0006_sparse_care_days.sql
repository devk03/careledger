-- DRAFT ONLY. This file is intentionally absent from database.py MIGRATIONS.
-- Do not register or apply it without separate approval. No data backfill.
-- TRUST BOUNDARY: This schema contains plaintext dates and family-note text.
-- It is suitable only for an explicitly trusted local database, NOT for the
-- hosted family-controlled E2EE storage path. Hosted metadata belongs inside
-- client-encrypted manifests; do not expose write routes for these tables there.

CREATE UNIQUE INDEX documents_id_profile_unique
ON documents (id, care_profile_id);

CREATE TABLE document_day_placements (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    document_id TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    FOREIGN KEY (document_id, care_profile_id)
        REFERENCES documents(id, care_profile_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX document_day_placements_profile_document
ON document_day_placements (care_profile_id, document_id);

CREATE TABLE document_day_placement_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    placement_id TEXT NOT NULL REFERENCES document_day_placements(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    care_day TEXT NOT NULL CHECK (
        length(care_day) = 10
        AND care_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(care_day) = care_day
    ),
    is_retracted INTEGER NOT NULL DEFAULT 0 CHECK (is_retracted IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE (placement_id, revision_no)
) STRICT;

CREATE INDEX document_day_placement_revisions_latest
ON document_day_placement_revisions (placement_id, revision_no DESC);

CREATE INDEX document_day_placement_revisions_care_day
ON document_day_placement_revisions (care_day DESC, placement_id);

CREATE TABLE document_day_placement_reviews (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    revision_id TEXT NOT NULL UNIQUE
        REFERENCES document_day_placement_revisions(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
    reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    decided_at INTEGER NOT NULL CHECK (decided_at > 0),
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 2000)
) STRICT;

CREATE INDEX document_day_placement_reviews_decision
ON document_day_placement_reviews (decision, revision_id);

CREATE TABLE family_notes (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE INDEX family_notes_profile
ON family_notes (care_profile_id, id);

CREATE TABLE family_note_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    note_id TEXT NOT NULL REFERENCES family_notes(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    care_day TEXT CHECK (
        care_day IS NULL OR (
            length(care_day) = 10
            AND care_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND date(care_day) = care_day
        )
    ),
    body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
    is_retracted INTEGER NOT NULL DEFAULT 0 CHECK (is_retracted IN (0, 1)),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE (note_id, revision_no)
) STRICT;

CREATE INDEX family_note_revisions_latest
ON family_note_revisions (note_id, revision_no DESC);

CREATE INDEX family_note_revisions_care_day
ON family_note_revisions (care_day DESC, note_id);

CREATE TABLE family_note_reviews (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    revision_id TEXT NOT NULL UNIQUE REFERENCES family_note_revisions(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
    reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    decided_at INTEGER NOT NULL CHECK (decided_at > 0),
    reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 2000)
) STRICT;

CREATE INDEX family_note_reviews_decision
ON family_note_reviews (decision, revision_id);

-- These views select the last ACCEPTED revision, not the newest proposal.
-- Every caller must still scope reads to an authorized care_profile_id.
CREATE VIEW current_accepted_document_days AS
SELECT p.id AS placement_id, p.care_profile_id, p.document_id,
       r.id AS revision_id, r.revision_no, r.care_day,
       review.reviewer_id, review.decided_at
FROM document_day_placements AS p
JOIN document_day_placement_revisions AS r ON r.placement_id = p.id
JOIN document_day_placement_reviews AS review
    ON review.revision_id = r.id AND review.decision = 'accepted'
WHERE r.is_retracted = 0
  AND r.revision_no = (
      SELECT max(r2.revision_no)
      FROM document_day_placement_revisions AS r2
      JOIN document_day_placement_reviews AS review2
          ON review2.revision_id = r2.id AND review2.decision = 'accepted'
      WHERE r2.placement_id = p.id
  );

CREATE VIEW current_accepted_family_notes AS
SELECT n.id AS note_id, n.care_profile_id,
       r.id AS revision_id, r.revision_no, r.care_day, r.body,
       r.created_by, r.created_at, review.reviewer_id, review.decided_at
FROM family_notes AS n
JOIN family_note_revisions AS r ON r.note_id = n.id
JOIN family_note_reviews AS review
    ON review.revision_id = r.id AND review.decision = 'accepted'
WHERE r.is_retracted = 0
  AND r.revision_no = (
      SELECT max(r2.revision_no)
      FROM family_note_revisions AS r2
      JOIN family_note_reviews AS review2
          ON review2.revision_id = r2.id AND review2.decision = 'accepted'
      WHERE r2.note_id = n.id
  );

CREATE TRIGGER document_day_placements_scope_insert
BEFORE INSERT ON document_day_placements
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE profile.id = NEW.care_profile_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'placement creator must be active in the care profile household');
END;

CREATE TRIGGER family_notes_scope_insert
BEFORE INSERT ON family_notes
WHEN NOT EXISTS (
    SELECT 1 FROM care_profiles AS profile
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE profile.id = NEW.care_profile_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, 'note creator must be active in the care profile household');
END;

CREATE TRIGGER document_day_placement_revisions_scope_insert
BEFORE INSERT ON document_day_placement_revisions
WHEN NOT EXISTS (
    SELECT 1 FROM document_day_placements AS placement
    JOIN care_profiles AS profile ON profile.id = placement.care_profile_id
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE placement.id = NEW.placement_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
) OR NEW.revision_no != COALESCE((
    SELECT max(revision_no) + 1
    FROM document_day_placement_revisions
    WHERE placement_id = NEW.placement_id
), 1)
BEGIN
    SELECT RAISE(ABORT, 'placement revision scope or sequence is invalid');
END;

CREATE TRIGGER family_note_revisions_scope_insert
BEFORE INSERT ON family_note_revisions
WHEN NOT EXISTS (
    SELECT 1 FROM family_notes AS note
    JOIN care_profiles AS profile ON profile.id = note.care_profile_id
    JOIN users AS actor ON actor.id = NEW.created_by
    WHERE note.id = NEW.note_id
      AND actor.household_id = profile.household_id
      AND actor.status = 'active'
) OR NEW.revision_no != COALESCE((
    SELECT max(revision_no) + 1
    FROM family_note_revisions
    WHERE note_id = NEW.note_id
), 1)
BEGIN
    SELECT RAISE(ABORT, 'note revision scope or sequence is invalid');
END;

CREATE TRIGGER document_day_placement_reviews_scope_insert
BEFORE INSERT ON document_day_placement_reviews
WHEN NOT EXISTS (
    SELECT 1 FROM document_day_placement_revisions AS revision
    JOIN document_day_placements AS placement ON placement.id = revision.placement_id
    JOIN care_profiles AS profile ON profile.id = placement.care_profile_id
    JOIN users AS reviewer ON reviewer.id = NEW.reviewer_id
    WHERE revision.id = NEW.revision_id
      AND reviewer.household_id = profile.household_id
      AND reviewer.status = 'active'
      AND NEW.decided_at >= revision.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'placement reviewer scope or time is invalid');
END;

CREATE TRIGGER family_note_reviews_scope_insert
BEFORE INSERT ON family_note_reviews
WHEN NOT EXISTS (
    SELECT 1 FROM family_note_revisions AS revision
    JOIN family_notes AS note ON note.id = revision.note_id
    JOIN care_profiles AS profile ON profile.id = note.care_profile_id
    JOIN users AS reviewer ON reviewer.id = NEW.reviewer_id
    WHERE revision.id = NEW.revision_id
      AND reviewer.household_id = profile.household_id
      AND reviewer.status = 'active'
      AND NEW.decided_at >= revision.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'note reviewer scope or time is invalid');
END;

CREATE TRIGGER document_day_placements_no_update
BEFORE UPDATE ON document_day_placements BEGIN
    SELECT RAISE(ABORT, 'placements are immutable');
END;
CREATE TRIGGER document_day_placements_no_delete
BEFORE DELETE ON document_day_placements BEGIN
    SELECT RAISE(ABORT, 'placements cannot be deleted');
END;
CREATE TRIGGER document_day_placement_revisions_no_update
BEFORE UPDATE ON document_day_placement_revisions BEGIN
    SELECT RAISE(ABORT, 'placement revisions are immutable');
END;
CREATE TRIGGER document_day_placement_revisions_no_delete
BEFORE DELETE ON document_day_placement_revisions BEGIN
    SELECT RAISE(ABORT, 'placement revisions cannot be deleted');
END;
CREATE TRIGGER document_day_placement_reviews_no_update
BEFORE UPDATE ON document_day_placement_reviews BEGIN
    SELECT RAISE(ABORT, 'placement reviews are immutable');
END;
CREATE TRIGGER document_day_placement_reviews_no_delete
BEFORE DELETE ON document_day_placement_reviews BEGIN
    SELECT RAISE(ABORT, 'placement reviews cannot be deleted');
END;
CREATE TRIGGER family_notes_no_update
BEFORE UPDATE ON family_notes BEGIN
    SELECT RAISE(ABORT, 'family notes are immutable');
END;
CREATE TRIGGER family_notes_no_delete
BEFORE DELETE ON family_notes BEGIN
    SELECT RAISE(ABORT, 'family notes cannot be deleted');
END;
CREATE TRIGGER family_note_revisions_no_update
BEFORE UPDATE ON family_note_revisions BEGIN
    SELECT RAISE(ABORT, 'family note revisions are immutable');
END;
CREATE TRIGGER family_note_revisions_no_delete
BEFORE DELETE ON family_note_revisions BEGIN
    SELECT RAISE(ABORT, 'family note revisions cannot be deleted');
END;
CREATE TRIGGER family_note_reviews_no_update
BEFORE UPDATE ON family_note_reviews BEGIN
    SELECT RAISE(ABORT, 'family note reviews are immutable');
END;
CREATE TRIGGER family_note_reviews_no_delete
BEFORE DELETE ON family_note_reviews BEGIN
    SELECT RAISE(ABORT, 'family note reviews cannot be deleted');
END;
