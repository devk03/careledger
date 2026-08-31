CREATE TRIGGER care_profiles_household_guard_insert
BEFORE INSERT ON care_profiles
WHEN NOT EXISTS (
    SELECT 1 FROM users
    WHERE users.id = NEW.created_by AND users.household_id = NEW.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'care profile creator must belong to the household');
END;

CREATE TRIGGER care_profiles_household_guard_update
BEFORE UPDATE ON care_profiles
WHEN NOT EXISTS (
    SELECT 1 FROM users
    WHERE users.id = NEW.created_by AND users.household_id = NEW.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'care profile creator must belong to the household');
END;

CREATE TRIGGER documents_profile_guard_insert
BEFORE INSERT ON documents
WHEN NOT EXISTS (
    SELECT 1
    FROM care_profiles
    JOIN users ON users.id = NEW.uploaded_by
    WHERE care_profiles.id = NEW.care_profile_id
      AND users.household_id = care_profiles.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'document uploader must belong to the care profile household');
END;

CREATE TRIGGER documents_profile_guard_update
BEFORE UPDATE ON documents
WHEN NOT EXISTS (
    SELECT 1
    FROM care_profiles
    JOIN users ON users.id = NEW.uploaded_by
    WHERE care_profiles.id = NEW.care_profile_id
      AND users.household_id = care_profiles.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'document uploader must belong to the care profile household');
END;

CREATE TRIGGER jobs_scope_guard_insert
BEFORE INSERT ON jobs
WHEN (
    NEW.care_profile_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM care_profiles
        WHERE care_profiles.id = NEW.care_profile_id
          AND care_profiles.household_id = NEW.household_id
    )
) OR (
    NEW.document_id IS NOT NULL
    AND (
        NEW.care_profile_id IS NULL
        OR NOT EXISTS (
            SELECT 1
            FROM documents
            JOIN care_profiles ON care_profiles.id = documents.care_profile_id
            WHERE documents.id = NEW.document_id
              AND documents.care_profile_id = NEW.care_profile_id
              AND care_profiles.household_id = NEW.household_id
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'job scope is inconsistent');
END;

CREATE TRIGGER jobs_scope_guard_update
BEFORE UPDATE ON jobs
WHEN (
    NEW.care_profile_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM care_profiles
        WHERE care_profiles.id = NEW.care_profile_id
          AND care_profiles.household_id = NEW.household_id
    )
) OR (
    NEW.document_id IS NOT NULL
    AND (
        NEW.care_profile_id IS NULL
        OR NOT EXISTS (
            SELECT 1
            FROM documents
            JOIN care_profiles ON care_profiles.id = documents.care_profile_id
            WHERE documents.id = NEW.document_id
              AND documents.care_profile_id = NEW.care_profile_id
              AND care_profiles.household_id = NEW.household_id
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'job scope is inconsistent');
END;

CREATE TRIGGER extraction_runs_scope_guard_insert
BEFORE INSERT ON extraction_runs
WHEN NOT EXISTS (
    SELECT 1 FROM documents
    WHERE documents.id = NEW.document_id
      AND documents.source_sha256 = NEW.source_sha256
) OR (
    NEW.job_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.id = NEW.job_id AND jobs.document_id = NEW.document_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'extraction run scope is inconsistent');
END;

CREATE TRIGGER extraction_runs_scope_guard_update
BEFORE UPDATE ON extraction_runs
WHEN NOT EXISTS (
    SELECT 1 FROM documents
    WHERE documents.id = NEW.document_id
      AND documents.source_sha256 = NEW.source_sha256
) OR (
    NEW.job_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.id = NEW.job_id AND jobs.document_id = NEW.document_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'extraction run scope is inconsistent');
END;

CREATE TRIGGER extraction_run_pages_scope_guard_insert
BEFORE INSERT ON extraction_run_pages
WHEN NOT EXISTS (
    SELECT 1
    FROM extraction_runs
    JOIN document_pages
      ON document_pages.document_id = extraction_runs.document_id
     AND document_pages.page_number = NEW.page_number
    JOIN derived_artifacts
      ON derived_artifacts.document_id = extraction_runs.document_id
     AND derived_artifacts.sha256 = NEW.artifact_sha256
     AND (
        derived_artifacts.page_number = NEW.page_number
        OR derived_artifacts.page_number IS NULL
     )
    WHERE extraction_runs.id = NEW.extraction_run_id
)
BEGIN
    SELECT RAISE(ABORT, 'extraction page artifact is inconsistent');
END;

CREATE TRIGGER derived_artifacts_page_guard_insert
BEFORE INSERT ON derived_artifacts
WHEN NEW.kind IN ('render', 'ocr', 'thumbnail') AND NEW.page_number IS NULL
BEGIN
    SELECT RAISE(ABORT, 'page artifact requires a page number');
END;

CREATE TRIGGER derived_artifacts_page_guard_update
BEFORE UPDATE ON derived_artifacts
WHEN NEW.kind IN ('render', 'ocr', 'thumbnail') AND NEW.page_number IS NULL
BEGIN
    SELECT RAISE(ABORT, 'page artifact requires a page number');
END;

CREATE TRIGGER evidence_revision_scope_guard
AFTER INSERT ON evidence_claim_revisions
WHEN NOT EXISTS (
    SELECT 1
    FROM evidence_claims
    JOIN care_profiles ON care_profiles.id = evidence_claims.care_profile_id
    JOIN users ON users.id = NEW.created_by
    WHERE evidence_claims.id = NEW.claim_id
      AND users.household_id = care_profiles.household_id
) OR (
    NEW.attested_by IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM evidence_claims
        JOIN care_profiles ON care_profiles.id = evidence_claims.care_profile_id
        JOIN users ON users.id = NEW.attested_by
        WHERE evidence_claims.id = NEW.claim_id
          AND users.household_id = care_profiles.household_id
    )
) OR EXISTS (
    SELECT 1
    FROM citations
    JOIN documents ON documents.id = citations.document_id
    JOIN evidence_claims ON evidence_claims.id = NEW.claim_id
    WHERE citations.claim_revision_id = NEW.id
      AND documents.care_profile_id != evidence_claims.care_profile_id
)
BEGIN
    SELECT RAISE(ABORT, 'evidence revision scope is inconsistent');
END;

CREATE TRIGGER timeline_revision_scope_guard
AFTER INSERT ON timeline_event_revisions
WHEN EXISTS (
    SELECT 1
    FROM timeline_event_source_claims AS source
    JOIN evidence_claims ON evidence_claims.id = source.claim_id
    JOIN timeline_events ON timeline_events.id = NEW.timeline_event_id
    WHERE source.timeline_event_revision_id = NEW.id
      AND evidence_claims.care_profile_id != timeline_events.care_profile_id
)
BEGIN
    SELECT RAISE(ABORT, 'timeline source scope is inconsistent');
END;

CREATE TRIGGER question_revision_scope_guard
AFTER INSERT ON question_revisions
WHEN EXISTS (
    SELECT 1
    FROM question_answer_source_claims AS source
    JOIN evidence_claims ON evidence_claims.id = source.claim_id
    JOIN questions ON questions.id = NEW.question_id
    WHERE source.question_revision_id = NEW.id
      AND evidence_claims.care_profile_id != questions.care_profile_id
)
BEGIN
    SELECT RAISE(ABORT, 'question source scope is inconsistent');
END;

CREATE TRIGGER decision_revision_scope_guard
AFTER INSERT ON decision_revisions
WHEN EXISTS (
    SELECT 1
    FROM decision_source_claims AS source
    JOIN evidence_claims ON evidence_claims.id = source.claim_id
    JOIN decisions ON decisions.id = NEW.decision_id
    WHERE source.decision_revision_id = NEW.id
      AND evidence_claims.care_profile_id != decisions.care_profile_id
) OR EXISTS (
    SELECT 1
    FROM decision_makers AS maker
    JOIN users ON users.id = maker.user_id
    JOIN decisions ON decisions.id = NEW.decision_id
    JOIN care_profiles ON care_profiles.id = decisions.care_profile_id
    WHERE maker.decision_revision_id = NEW.id
      AND users.household_id != care_profiles.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'decision scope is inconsistent');
END;

CREATE TRIGGER followup_revision_scope_guard
AFTER INSERT ON followup_revisions
WHEN EXISTS (
    SELECT 1
    FROM followup_source_claims AS source
    JOIN evidence_claims ON evidence_claims.id = source.claim_id
    JOIN followups ON followups.id = NEW.followup_id
    WHERE source.followup_revision_id = NEW.id
      AND evidence_claims.care_profile_id != followups.care_profile_id
)
BEGIN
    SELECT RAISE(ABORT, 'follow-up source scope is inconsistent');
END;

CREATE TRIGGER audit_events_chain_guard
BEFORE INSERT ON audit_events
WHEN (
    NEW.actor_user_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE users.id = NEW.actor_user_id
          AND users.household_id = NEW.household_id
    )
) OR (
    (SELECT COUNT(*) FROM audit_events) = 0
    AND NEW.previous_hash IS NOT NULL
) OR (
    (SELECT COUNT(*) FROM audit_events) > 0
    AND NEW.previous_hash IS NOT (
        SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1
    )
)
BEGIN
    SELECT RAISE(ABORT, 'audit event chain is inconsistent');
END;

CREATE INDEX audit_events_household_sequence
ON audit_events (household_id, sequence);

CREATE INDEX citations_document_page
ON citations (document_id, page_number, position);

CREATE INDEX extraction_run_pages_artifact
ON extraction_run_pages (artifact_sha256, extraction_run_id);

CREATE INDEX timeline_sources_claim_revision
ON timeline_event_source_claims (claim_revision_id, timeline_event_revision_id);

CREATE INDEX question_sources_claim_revision
ON question_answer_source_claims (claim_revision_id, question_revision_id);

CREATE INDEX decision_sources_claim_revision
ON decision_source_claims (claim_revision_id, decision_revision_id);

CREATE INDEX followup_sources_claim_revision
ON followup_source_claims (claim_revision_id, followup_revision_id);
