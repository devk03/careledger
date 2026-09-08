# Product Brief

Current build priority: [core platform](core-platform.md). Outbound notifications and communication integrations are explicitly deferred; approved updates are read inside the family portal first.

Long-term direction: [community-funded access, fiscal sponsorship, and privacy commitments](long-term-goal.md). This is the controlling direction for funding and public/private tooling scope; implementation remains subject to the launch gates described there.

## Name and primary experience

The product name is Adeno. Hosted use comes first: a caregiver visits the website, creates an account, invites family, and starts adding records and thoughts. The operator handles infrastructure and AI access. Pricing covers inference, search, storage, hosting and payment costs transparently; the project has no profit objective. No API-key setup or model selection belongs in ordinary onboarding.

The caregiver application remains open source; private operator/admin tooling may be maintained separately. Self-hosting is an optional advanced path, documented separately from the caregiver journey. The current local build still uses installation-owner setup while hosted onboarding is developed; a restricted hosted preview is not a public production launch. Individual family logins and a versioned approved-update feed are not implemented yet.

The home view answers “What needs attention?” with My responsibilities first and a Whole family switch. Records accepts files and unorganized notes; Timeline keeps event dates distinct from upload dates; Ask includes record questions and current research; Tasks shows owner, reason, source and due date. Google Calendar integration is planned, with explicit sharing of event details. Family permissions and explanation level are separate controls.

## Rename compatibility

Use Adeno in visible UI, page metadata and product documentation. Existing internal `careledger` package names, repository/directory paths, container service/volume names, cookies, backup formats, crypto domain separators and storage identifiers remain compatibility identifiers. Renaming them requires a separate reviewed transition; branding alone must not invalidate records or keys. Public repository/domain changes are a publication task. The personal origin of the name is not included in public-facing copy.

## Audience

Adult caregivers coordinating health care for a parent or loved one. They may be stressed, unfamiliar with medical language, and working across time zones, hospitals, and family members.

Clinicians are not the primary users. Exports should be concise enough to share with them.

## Core job

Upload records, confirm what the records actually say, understand the situation in plain language, and leave with a small prioritized list of next actions and doctor questions.

## The caregiver loop

1. Add a care event: treatment, consultation, new result, discharge, or family observation.
2. Upload its records and unorganized personal notes; preserve event, document and upload dates separately.
3. Prepare one family-update draft with source-linked facts, simple explanations, uncertainties and proposed tasks.
4. A permitted caregiver reviews, edits and approves the update. Approval is editorial, not medical verification.
5. Family members sign in with their own accounts to read that approved version, open its sources and see their own responsibilities.
6. Track commitments and questions for the next visit. No outbound message is needed to complete this loop.

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
