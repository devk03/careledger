CREATE TRIGGER timeline_revision_actor_scope_guard
AFTER INSERT ON timeline_event_revisions
WHEN NOT EXISTS (
    SELECT 1
    FROM timeline_events
    JOIN care_profiles ON care_profiles.id = timeline_events.care_profile_id
    JOIN users ON users.id = NEW.created_by
    WHERE timeline_events.id = NEW.timeline_event_id
      AND users.household_id = care_profiles.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'timeline actor scope is inconsistent');
END;

CREATE TRIGGER question_revision_actor_scope_guard
AFTER INSERT ON question_revisions
WHEN NOT EXISTS (
    SELECT 1
    FROM questions
    JOIN care_profiles ON care_profiles.id = questions.care_profile_id
    JOIN users ON users.id = NEW.created_by
    WHERE questions.id = NEW.question_id
      AND users.household_id = care_profiles.household_id
) OR (
    NEW.owner_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM questions
        JOIN care_profiles ON care_profiles.id = questions.care_profile_id
        JOIN users ON users.id = NEW.owner_id
        WHERE questions.id = NEW.question_id
          AND users.household_id = care_profiles.household_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'question actor scope is inconsistent');
END;

CREATE TRIGGER decision_revision_actor_scope_guard
AFTER INSERT ON decision_revisions
WHEN NOT EXISTS (
    SELECT 1
    FROM decisions
    JOIN care_profiles ON care_profiles.id = decisions.care_profile_id
    JOIN users ON users.id = NEW.created_by
    WHERE decisions.id = NEW.decision_id
      AND users.household_id = care_profiles.household_id
)
BEGIN
    SELECT RAISE(ABORT, 'decision actor scope is inconsistent');
END;

CREATE TRIGGER followup_revision_actor_scope_guard
AFTER INSERT ON followup_revisions
WHEN NOT EXISTS (
    SELECT 1
    FROM followups
    JOIN care_profiles ON care_profiles.id = followups.care_profile_id
    JOIN users ON users.id = NEW.created_by
    WHERE followups.id = NEW.followup_id
      AND users.household_id = care_profiles.household_id
) OR (
    NEW.owner_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM followups
        JOIN care_profiles ON care_profiles.id = followups.care_profile_id
        JOIN users ON users.id = NEW.owner_id
        WHERE followups.id = NEW.followup_id
          AND users.household_id = care_profiles.household_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'follow-up actor scope is inconsistent');
END;
