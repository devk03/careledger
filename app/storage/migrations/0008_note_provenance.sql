-- Additive provenance for newly proposed notes. Historical revisions stay unchanged.
CREATE TABLE family_note_provenance (
    note_revision_id TEXT PRIMARY KEY REFERENCES family_note_revisions(id) ON DELETE RESTRICT,
    reporter_label TEXT CHECK (reporter_label IS NULL OR length(trim(reporter_label)) BETWEEN 1 AND 120),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'family_observation', 'clinician_communication', 'document', 'research_context', 'unknown'
    )),
    source_description TEXT CHECK (source_description IS NULL OR length(trim(source_description)) BETWEEN 1 AND 1000),
    document_id TEXT,
    page_number INTEGER,
    FOREIGN KEY (document_id, page_number) REFERENCES document_pages(document_id, page_number) ON DELETE RESTRICT,
    CHECK ((document_id IS NULL AND page_number IS NULL) OR (document_id IS NOT NULL AND page_number >= 1)),
    CHECK (source_kind != 'document' OR document_id IS NOT NULL)
) STRICT;

CREATE TRIGGER family_note_provenance_scope_insert
BEFORE INSERT ON family_note_provenance
WHEN NOT EXISTS (
    SELECT 1 FROM family_note_revisions revision
    JOIN family_notes note ON note.id = revision.note_id
    JOIN care_profiles profile ON profile.id = note.care_profile_id
    JOIN users actor ON actor.id = revision.created_by AND actor.household_id = profile.household_id
    WHERE revision.id = NEW.note_revision_id AND actor.status = 'active' AND profile.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM family_note_reviews review WHERE review.revision_id = revision.id)
      AND (NEW.document_id IS NULL OR EXISTS (
          SELECT 1 FROM documents document
          WHERE document.id = NEW.document_id AND document.care_profile_id = profile.id
            AND document.archived_at IS NULL AND document.scan_verdict = 'clean'
            AND (actor.role = 'owner' OR EXISTS (
                SELECT 1 FROM current_document_access access
                WHERE access.document_id = document.id AND access.care_profile_id = profile.id AND access.subject_user_id = actor.id
            ) OR (document.uploaded_by = actor.id AND EXISTS (
                SELECT 1 FROM current_profile_intake intake
                WHERE intake.care_profile_id = profile.id AND intake.subject_user_id = actor.id
            )))
      ))
)
BEGIN
    SELECT RAISE(ABORT, 'note provenance scope or source access is invalid');
END;

CREATE TRIGGER family_note_provenance_no_update
BEFORE UPDATE ON family_note_provenance BEGIN
    SELECT RAISE(ABORT, 'note provenance is immutable');
END;
CREATE TRIGGER family_note_provenance_no_delete
BEFORE DELETE ON family_note_provenance BEGIN
    SELECT RAISE(ABORT, 'note provenance cannot be deleted');
END;
