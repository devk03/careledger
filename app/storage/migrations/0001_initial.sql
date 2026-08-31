CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
    sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    app_version TEXT NOT NULL CHECK (length(trim(app_version)) > 0),
    applied_at INTEGER NOT NULL CHECK (applied_at > 0)
) STRICT;

CREATE TABLE households (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 64),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE app_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    setup_completed_at INTEGER CHECK (setup_completed_at IS NULL OR setup_completed_at > 0),
    active_household_id TEXT REFERENCES households(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (
        (setup_completed_at IS NULL AND active_household_id IS NULL)
        OR (setup_completed_at IS NOT NULL AND active_household_id IS NOT NULL)
    )
) STRICT;

INSERT INTO app_state (singleton, setup_completed_at, active_household_id, created_at)
VALUES (1, NULL, NULL, unixepoch());

CREATE TABLE users (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    login_name TEXT NOT NULL CHECK (length(trim(login_name)) BETWEEN 1 AND 80),
    login_name_normalized TEXT NOT NULL CHECK (
        length(trim(login_name_normalized)) BETWEEN 1 AND 80
    ),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    role TEXT NOT NULL CHECK (role IN ('owner', 'caregiver')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    password_hash TEXT,
    auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    password_changed_at INTEGER CHECK (
        password_changed_at IS NULL OR password_changed_at >= created_at
    ),
    disabled_at INTEGER CHECK (disabled_at IS NULL OR disabled_at >= created_at),
    CHECK (
        (status = 'active' AND password_hash LIKE '$argon2id$%')
        OR status != 'active'
    ),
    CHECK (
        (status = 'disabled' AND disabled_at IS NOT NULL)
        OR (status != 'disabled' AND disabled_at IS NULL)
    ),
    UNIQUE (household_id, login_name_normalized)
) STRICT;

CREATE UNIQUE INDEX users_one_active_owner
ON users (household_id)
WHERE role = 'owner' AND status = 'active';

CREATE INDEX users_household_status
ON users (household_id, status, created_at);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_sha256 TEXT NOT NULL UNIQUE CHECK (
        length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    csrf_secret BLOB NOT NULL CHECK (length(csrf_secret) = 32),
    auth_version INTEGER NOT NULL CHECK (auth_version >= 1),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= created_at),
    revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE INDEX sessions_user_expiry
ON sessions (user_id, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    batch_id TEXT NOT NULL CHECK (length(batch_id) BETWEEN 1 AND 64),
    code_hmac TEXT NOT NULL UNIQUE CHECK (
        length(code_hmac) = 64 AND code_hmac NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    used_at INTEGER CHECK (used_at IS NULL OR used_at >= created_at),
    revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE INDEX recovery_codes_available
ON recovery_codes (user_id, batch_id, created_at)
WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE auth_throttles (
    scope TEXT PRIMARY KEY CHECK (scope IN ('setup', 'login', 'recovery')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    locked_until INTEGER CHECK (locked_until IS NULL OR locked_until >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE invitations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    token_sha256 TEXT NOT NULL UNIQUE CHECK (
        length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    role TEXT NOT NULL CHECK (role = 'caregiver'),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    accepted_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
    accepted_at INTEGER,
    CHECK (
        (accepted_by IS NULL AND accepted_at IS NULL)
        OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
    )
) STRICT;

CREATE TABLE care_profiles (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    preferred_name TEXT NOT NULL CHECK (length(trim(preferred_name)) BETWEEN 1 AND 120),
    birth_date TEXT,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at)
) STRICT;

CREATE INDEX care_profiles_active
ON care_profiles (household_id, created_at)
WHERE archived_at IS NULL;

CREATE TABLE source_objects (
    sha256 TEXT PRIMARY KEY CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    media_type TEXT NOT NULL CHECK (
        media_type IN ('application/pdf', 'image/jpeg', 'image/png')
    ),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    verified_at INTEGER CHECK (verified_at IS NULL OR verified_at >= created_at)
) STRICT;

CREATE TABLE documents (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    source_sha256 TEXT NOT NULL REFERENCES source_objects(sha256) ON DELETE RESTRICT,
    original_display_name TEXT NOT NULL CHECK (
        length(trim(original_display_name)) BETWEEN 1 AND 180
    ),
    title TEXT CHECK (title IS NULL OR length(trim(title)) BETWEEN 1 AND 180),
    record_date TEXT,
    record_date_text TEXT,
    scan_verdict TEXT NOT NULL CHECK (
        scan_verdict IN ('clean', 'detected', 'unavailable', 'not_configured')
    ),
    scan_engine TEXT,
    page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    status TEXT NOT NULL CHECK (
        status IN ('ready', 'processing', 'needs_review', 'complete', 'failed', 'archived')
    ),
    safe_error_code TEXT,
    uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    uploaded_at INTEGER NOT NULL CHECK (uploaded_at > 0),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= uploaded_at),
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
    UNIQUE (id, source_sha256)
) STRICT;

CREATE INDEX documents_profile_uploaded
ON documents (care_profile_id, uploaded_at DESC);

CREATE INDEX documents_source
ON documents (source_sha256);

CREATE INDEX documents_status
ON documents (status, uploaded_at);

CREATE TABLE document_pages (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    extracted_text TEXT,
    text_sha256 TEXT CHECK (
        text_sha256 IS NULL
        OR (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*')
    ),
    extraction_method TEXT,
    created_by_job_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (
        (extracted_text IS NULL AND text_sha256 IS NULL)
        OR (extracted_text IS NOT NULL AND text_sha256 IS NOT NULL)
    ),
    PRIMARY KEY (document_id, page_number)
) STRICT;

CREATE TABLE derived_artifacts (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    page_number INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('render', 'ocr', 'thumbnail', 'normalized_input')),
    sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
    storage_key TEXT NOT NULL CHECK (
        length(trim(storage_key)) > 0
        AND storage_key NOT LIKE '/%'
        AND storage_key NOT LIKE '%..%'
        AND storage_key NOT LIKE '%\%'
    ),
    generator_version TEXT NOT NULL CHECK (length(trim(generator_version)) > 0),
    created_by_job_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    FOREIGN KEY (document_id, page_number)
        REFERENCES document_pages(document_id, page_number) ON DELETE RESTRICT,
    UNIQUE (document_id, page_number, kind, sha256)
) STRICT;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    care_profile_id TEXT REFERENCES care_profiles(id) ON DELETE RESTRICT,
    document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
    job_type TEXT NOT NULL CHECK (
        job_type IN ('preprocess', 'extract', 'reindex', 'backup', 'restore_verify')
    ),
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'leased', 'retry', 'completed', 'failed', 'cancelled')
    ),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_sha256 TEXT NOT NULL CHECK (
        length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    safe_error_code TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state != 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
        (state IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
        OR (state NOT IN ('completed', 'failed', 'cancelled') AND completed_at IS NULL)
    ),
    UNIQUE (household_id, idempotency_key)
) STRICT;

CREATE INDEX jobs_dequeue
ON jobs (priority DESC, available_at, created_at)
WHERE state IN ('queued', 'retry');

CREATE INDEX jobs_expired_leases
ON jobs (lease_expires_at)
WHERE state = 'leased';

CREATE TABLE extraction_runs (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
    job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'validated', 'failed', 'cancelled')
    ),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    requested_model TEXT NOT NULL CHECK (length(trim(requested_model)) > 0),
    response_model TEXT,
    contract_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL CHECK (
        length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    schema_sha256 TEXT NOT NULL CHECK (
        length(schema_sha256) = 64 AND schema_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    source_sha256 TEXT NOT NULL REFERENCES source_objects(sha256) ON DELETE RESTRICT,
    transmitted_sha256 TEXT NOT NULL CHECK (
        length(transmitted_sha256) = 64 AND transmitted_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    payload_sha256 TEXT CHECK (
        payload_sha256 IS NULL
        OR (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')
    ),
    sdk_version TEXT NOT NULL,
    batch_token TEXT NOT NULL UNIQUE,
    response_id TEXT,
    response_created_at INTEGER,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    safe_error_code TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (
        (status = 'validated' AND payload_json IS NOT NULL AND payload_sha256 IS NOT NULL)
        OR status != 'validated'
    )
) STRICT;

CREATE INDEX extraction_runs_document
ON extraction_runs (document_id, created_at DESC);

CREATE TABLE extraction_run_pages (
    extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE RESTRICT,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    artifact_sha256 TEXT NOT NULL CHECK (
        length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (extraction_run_id, page_number)
) STRICT;

CREATE TABLE evidence_claims (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE evidence_claim_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    claim_id TEXT NOT NULL REFERENCES evidence_claims(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    kind TEXT NOT NULL CHECK (
        kind IN (
            'source_documented_fact', 'user_attested_confirmed_fact',
            'clinician_interpretation', 'unconfirmed_recollection',
            'research_context', 'agent_inference'
        )
    ),
    review_state TEXT NOT NULL CHECK (
        review_state IN ('proposed', 'accepted', 'rejected', 'superseded')
    ),
    fact_type TEXT,
    statement TEXT NOT NULL CHECK (length(trim(statement)) > 0),
    plain_language TEXT,
    certainty TEXT NOT NULL CHECK (certainty IN ('explicit', 'qualified', 'uncertain')),
    qualifier_text TEXT,
    event_date TEXT,
    extraction_run_id TEXT REFERENCES extraction_runs(id) ON DELETE RESTRICT,
    candidate_ref TEXT,
    attested_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
    supersedes_claim_id TEXT REFERENCES evidence_claims(id) ON DELETE RESTRICT,
    citation_count INTEGER NOT NULL CHECK (citation_count >= 0),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (
        kind NOT IN ('source_documented_fact', 'clinician_interpretation')
        OR citation_count > 0
    ),
    CHECK (
        (kind = 'user_attested_confirmed_fact' AND attested_by IS NOT NULL)
        OR (kind != 'user_attested_confirmed_fact' AND attested_by IS NULL)
    ),
    CHECK (kind != 'agent_inference' OR review_state = 'proposed'),
    CHECK (
        (certainty = 'qualified' AND length(trim(qualifier_text)) > 0)
        OR (certainty != 'qualified' AND qualifier_text IS NULL)
    ),
    CHECK (review_state != 'superseded' OR supersedes_claim_id IS NOT NULL),
    UNIQUE (claim_id, revision_no),
    UNIQUE (claim_id, id)
) STRICT;

CREATE UNIQUE INDEX evidence_run_candidate
ON evidence_claim_revisions (extraction_run_id, candidate_ref)
WHERE extraction_run_id IS NOT NULL AND candidate_ref IS NOT NULL;

CREATE TABLE citations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    claim_revision_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    quote TEXT,
    bbox_x0 REAL,
    bbox_y0 REAL,
    bbox_x1 REAL,
    bbox_y1 REAL,
    position INTEGER NOT NULL CHECK (position >= 0),
    FOREIGN KEY (claim_revision_id)
        REFERENCES evidence_claim_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (document_id, source_sha256)
        REFERENCES documents(id, source_sha256) ON DELETE RESTRICT,
    FOREIGN KEY (document_id, page_number)
        REFERENCES document_pages(document_id, page_number) ON DELETE RESTRICT,
    CHECK (
        length(trim(COALESCE(quote, ''))) > 0
        OR (
            bbox_x0 IS NOT NULL AND bbox_y0 IS NOT NULL
            AND bbox_x1 IS NOT NULL AND bbox_y1 IS NOT NULL
        )
    ),
    CHECK (
        (bbox_x0 IS NULL AND bbox_y0 IS NULL AND bbox_x1 IS NULL AND bbox_y1 IS NULL)
        OR (
            bbox_x0 >= 0 AND bbox_y0 >= 0 AND bbox_x1 <= 1 AND bbox_y1 <= 1
            AND bbox_x0 < bbox_x1 AND bbox_y0 < bbox_y1
        )
    ),
    UNIQUE (claim_revision_id, position)
) STRICT;

CREATE TRIGGER evidence_revision_citation_count
AFTER INSERT ON evidence_claim_revisions
WHEN NEW.citation_count != (
    SELECT COUNT(*) FROM citations WHERE claim_revision_id = NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'citation count mismatch');
END;

CREATE VIEW current_evidence_claim_revisions AS
SELECT revision.*
FROM evidence_claim_revisions AS revision
JOIN (
    SELECT claim_id, MAX(revision_no) AS revision_no
    FROM evidence_claim_revisions
    GROUP BY claim_id
) AS current
ON current.claim_id = revision.claim_id
AND current.revision_no = revision.revision_no;

CREATE TABLE timeline_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE timeline_event_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    timeline_event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    occurred_at INTEGER,
    date_text TEXT,
    source_count INTEGER NOT NULL CHECK (source_count > 0),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (occurred_at IS NOT NULL OR length(trim(COALESCE(date_text, ''))) > 0),
    UNIQUE (timeline_event_id, revision_no),
    UNIQUE (timeline_event_id, id)
) STRICT;

CREATE TABLE timeline_event_source_claims (
    timeline_event_revision_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    claim_id TEXT NOT NULL,
    claim_revision_id TEXT NOT NULL,
    FOREIGN KEY (timeline_event_revision_id)
        REFERENCES timeline_event_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (claim_id, claim_revision_id)
        REFERENCES evidence_claim_revisions(claim_id, id) ON DELETE RESTRICT,
    PRIMARY KEY (timeline_event_revision_id, position)
) STRICT;

CREATE TRIGGER timeline_revision_source_count
AFTER INSERT ON timeline_event_revisions
WHEN NEW.source_count != (
    SELECT COUNT(*) FROM timeline_event_source_claims
    WHERE timeline_event_revision_id = NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'timeline source count mismatch');
END;

CREATE TABLE questions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE question_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    priority TEXT NOT NULL CHECK (
        priority IN ('before_next_visit', 'at_next_visit', 'when_possible')
    ),
    state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'completed', 'cancelled')),
    owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    due_date TEXT,
    answer TEXT CHECK (answer IS NULL OR length(trim(answer)) > 0),
    answer_source_count INTEGER NOT NULL DEFAULT 0 CHECK (answer_source_count >= 0),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (answer IS NOT NULL OR answer_source_count = 0),
    UNIQUE (question_id, revision_no),
    UNIQUE (question_id, id)
) STRICT;

CREATE TABLE question_answer_source_claims (
    question_revision_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    claim_id TEXT NOT NULL,
    claim_revision_id TEXT NOT NULL,
    FOREIGN KEY (question_revision_id)
        REFERENCES question_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (claim_id, claim_revision_id)
        REFERENCES evidence_claim_revisions(claim_id, id) ON DELETE RESTRICT,
    PRIMARY KEY (question_revision_id, position)
) STRICT;

CREATE TRIGGER question_revision_source_count
AFTER INSERT ON question_revisions
WHEN NEW.answer_source_count != (
    SELECT COUNT(*) FROM question_answer_source_claims
    WHERE question_revision_id = NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'question answer source count mismatch');
END;

CREATE TABLE decisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE decision_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    decided_at INTEGER NOT NULL CHECK (decided_at > 0),
    rationale TEXT,
    maker_count INTEGER NOT NULL CHECK (maker_count > 0),
    source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    UNIQUE (decision_id, revision_no),
    UNIQUE (decision_id, id)
) STRICT;

CREATE TABLE decision_makers (
    decision_revision_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (decision_revision_id)
        REFERENCES decision_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (decision_revision_id, position)
) STRICT;

CREATE TABLE decision_source_claims (
    decision_revision_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    claim_id TEXT NOT NULL,
    claim_revision_id TEXT NOT NULL,
    FOREIGN KEY (decision_revision_id)
        REFERENCES decision_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (claim_id, claim_revision_id)
        REFERENCES evidence_claim_revisions(claim_id, id) ON DELETE RESTRICT,
    PRIMARY KEY (decision_revision_id, position)
) STRICT;

CREATE TRIGGER decision_revision_counts
AFTER INSERT ON decision_revisions
WHEN NEW.maker_count != (
    SELECT COUNT(*) FROM decision_makers WHERE decision_revision_id = NEW.id
) OR NEW.source_count != (
    SELECT COUNT(*) FROM decision_source_claims WHERE decision_revision_id = NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'decision relationship count mismatch');
END;

CREATE TABLE followups (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE followup_revisions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    followup_id TEXT NOT NULL REFERENCES followups(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    source TEXT NOT NULL CHECK (
        source IN ('clinician_instruction', 'caregiver_task', 'ai_draft')
    ),
    state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'completed', 'cancelled')),
    owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    due_date TEXT,
    source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    CHECK (source != 'clinician_instruction' OR source_count > 0),
    CHECK (source != 'ai_draft' OR state != 'completed'),
    UNIQUE (followup_id, revision_no),
    UNIQUE (followup_id, id)
) STRICT;

CREATE TABLE followup_source_claims (
    followup_revision_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    claim_id TEXT NOT NULL,
    claim_revision_id TEXT NOT NULL,
    FOREIGN KEY (followup_revision_id)
        REFERENCES followup_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (claim_id, claim_revision_id)
        REFERENCES evidence_claim_revisions(claim_id, id) ON DELETE RESTRICT,
    PRIMARY KEY (followup_revision_id, position)
) STRICT;

CREATE TRIGGER followup_revision_source_count
AFTER INSERT ON followup_revisions
WHEN NEW.source_count != (
    SELECT COUNT(*) FROM followup_source_claims WHERE followup_revision_id = NEW.id
)
BEGIN
    SELECT RAISE(ABORT, 'follow-up source count mismatch');
END;

CREATE TABLE search_entries (
    id INTEGER PRIMARY KEY,
    care_profile_id TEXT NOT NULL REFERENCES care_profiles(id) ON DELETE RESTRICT,
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('document_page', 'accepted_claim')),
    entity_key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
    page_number INTEGER,
    updated_at INTEGER NOT NULL CHECK (updated_at > 0),
    UNIQUE (care_profile_id, entity_kind, entity_key)
) STRICT;

CREATE VIRTUAL TABLE search_entries_fts USING fts5(
    title,
    body,
    care_profile_id UNINDEXED,
    entity_kind UNINDEXED,
    entity_key UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 64),
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 80),
    entity_kind TEXT NOT NULL CHECK (length(trim(entity_kind)) BETWEEN 1 AND 80),
    entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 64),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
    previous_hash TEXT CHECK (
        previous_hash IS NULL
        OR (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')
    ),
    event_hash TEXT NOT NULL UNIQUE CHECK (
        length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'
    )
) STRICT;

CREATE TRIGGER source_objects_no_update
BEFORE UPDATE ON source_objects
BEGIN
    SELECT RAISE(ABORT, 'source objects are immutable');
END;

CREATE TRIGGER source_objects_no_delete
BEFORE DELETE ON source_objects
BEGIN
    SELECT RAISE(ABORT, 'source objects cannot be deleted');
END;

CREATE TRIGGER documents_no_delete
BEFORE DELETE ON documents
BEGIN
    SELECT RAISE(ABORT, 'documents must be archived');
END;

CREATE TRIGGER evidence_claims_no_delete
BEFORE DELETE ON evidence_claims
BEGIN
    SELECT RAISE(ABORT, 'evidence claims cannot be deleted');
END;

CREATE TRIGGER evidence_revisions_no_update
BEFORE UPDATE ON evidence_claim_revisions
BEGIN
    SELECT RAISE(ABORT, 'evidence revisions are immutable');
END;

CREATE TRIGGER evidence_revisions_no_delete
BEFORE DELETE ON evidence_claim_revisions
BEGIN
    SELECT RAISE(ABORT, 'evidence revisions cannot be deleted');
END;

CREATE TRIGGER citations_no_update
BEFORE UPDATE ON citations
BEGIN
    SELECT RAISE(ABORT, 'citations are immutable');
END;

CREATE TRIGGER citations_no_delete
BEFORE DELETE ON citations
BEGIN
    SELECT RAISE(ABORT, 'citations cannot be deleted');
END;

CREATE TRIGGER timeline_revisions_no_update
BEFORE UPDATE ON timeline_event_revisions
BEGIN
    SELECT RAISE(ABORT, 'timeline revisions are immutable');
END;

CREATE TRIGGER timeline_revisions_no_delete
BEFORE DELETE ON timeline_event_revisions
BEGIN
    SELECT RAISE(ABORT, 'timeline revisions cannot be deleted');
END;

CREATE TRIGGER question_revisions_no_update
BEFORE UPDATE ON question_revisions
BEGIN
    SELECT RAISE(ABORT, 'question revisions are immutable');
END;

CREATE TRIGGER question_revisions_no_delete
BEFORE DELETE ON question_revisions
BEGIN
    SELECT RAISE(ABORT, 'question revisions cannot be deleted');
END;

CREATE TRIGGER decision_revisions_no_update
BEFORE UPDATE ON decision_revisions
BEGIN
    SELECT RAISE(ABORT, 'decision revisions are immutable');
END;

CREATE TRIGGER decision_revisions_no_delete
BEFORE DELETE ON decision_revisions
BEGIN
    SELECT RAISE(ABORT, 'decision revisions cannot be deleted');
END;

CREATE TRIGGER followup_revisions_no_update
BEFORE UPDATE ON followup_revisions
BEGIN
    SELECT RAISE(ABORT, 'follow-up revisions are immutable');
END;

CREATE TRIGGER followup_revisions_no_delete
BEFORE DELETE ON followup_revisions
BEGIN
    SELECT RAISE(ABORT, 'follow-up revisions cannot be deleted');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit events are append-only');
END;
