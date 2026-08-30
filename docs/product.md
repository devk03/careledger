# Product Brief

## Audience

Adult caregivers coordinating health care for a parent or loved one. They may be stressed, unfamiliar with medical language, and working across time zones, hospitals, and family members.

Clinicians are not the primary users. Exports should be concise enough to share with them.

## Core job

Upload records, confirm what the records actually say, understand the situation in plain language, and leave with a small prioritized list of next actions and doctor questions.

## The caregiver loop

1. Add a loved one and upload records.
2. Review extracted facts beside the original page.
3. Approve, reject, or correct each proposal.
4. See the current situation in four sections: known, meaning, unknown, next.
5. Prepare for an appointment and track commitments afterward.

## Information hierarchy

Every statement belongs to exactly one category:

- `source-documented fact`
- `clinician interpretation`
- `user-attested fact`
- `AI draft/inference`
- `general research context`
- `unresolved conflict`

Categories are visible in the interface and preserved in exports.

## Plain-language explanations

The default explanation answers:

- What does this term mean?
- What does this record actually establish?
- What does it not establish?
- Why might the care team care about it?
- What is one useful question to ask?

The exact report wording and citation remain one click away. Reading level targets plain adult language without infantilizing the user.

## Trust rules

- AI never labels a draft as confirmed.
- Research never becomes patient fact without a patient-specific source and human review.
- A normal test never becomes proof that disease is absent.
- Imaging suspicion never becomes tissue confirmation.
- Changes preserve prior values and authorship.
- Every high-stakes screen shows the source and last review date.

## Design direction

Tone: kind, gentle, explanatory, and exact.

Genre: modern-minimal. Macrostructure: Workbench. Theme: warm-paper Coral. The product uses real document/page previews as its visual content; no invented medical imagery, mascots, gamification, celebratory motion, or fear-based red alerts.

Primary layout:

- Quiet top bar with global evidence search.
- Care profile context and next action remain visible.
- Main workbench pairs a source-page pane with a structured review pane.
- Mobile collapses to one pane with an explicit `Source` / `Explanation` switch.
- Status never relies on colour alone.

Copy examples:

- `Upload records`
- `Review 6 proposed facts`
- `This is supported by page 2`
- `The record does not identify the primary site`
- `Ask who owns this follow-up and when it is due`

Avoid `AI diagnosis`, `medical certainty`, `everything looks normal`, `no need to worry`, `stage`, or treatment recommendations unless a signed source explicitly supplies them.
