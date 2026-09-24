# Product Brief

Current product center (2026-09-23): [The sparse day-by-day timeline](treatment-timeline-product.md) is the primary web interface and shared source of truth. Members attach files and notes to care days; their agents can query approved source material through MCP. Built-in analysis, generated updates and broad research are optional later work. The broader ideas below are context and backlog, not additional first-release screens.

Earlier agent-connection direction (2026-09-22): the [MCP plan](mcp-first-product.md) lets each adult use a compatible AI client through their own adeno authorization. This is an additional interaction path. Uploads, the visual history, evidence review, update approval and access control remain on the website. No MCP endpoint exists yet.

Current build priority: [source storage and agent connector](typescript-platform.md). Outbound notifications and communication integrations are deferred.

Long-term direction: [community-funded access, fiscal sponsorship, and privacy commitments](long-term-goal.md). This is the controlling direction for funding and public/private tooling scope; implementation remains subject to the launch gates described there.

## Name and primary experience

The product name is adeno. The long-term release target is hosted use: a caregiver visits the website, creates an account, invites family, and starts adding records and thoughts. The operator handles infrastructure; the caregiver's chosen AI client handles interpretation through scoped MCP access. Optional adeno-operated processing, if ever added, must be cost-metered without a profit objective. No API-key setup or model selection belongs in ordinary onboarding.

The caregiver application remains open source; private operator/admin tooling may be maintained separately. Self-hosting is an optional advanced path, documented separately from the caregiver journey. The current local build still uses installation-owner setup while hosted onboarding is developed; a restricted hosted preview is not a public production launch. Individual family logins and a versioned approved-update feed are not implemented yet.

The first web view centers a sparse care-day timeline and file/note intake. It keeps care dates distinct from document and upload dates. Family tasks, research, calendar sync and an in-app Ask view remain later possibilities; they do not define the core data store.

## Rename compatibility

Use adeno in visible UI, page metadata and product documentation. Existing internal `careledger` package names, repository/directory paths, container service/volume names, cookies, backup formats, crypto domain separators and storage identifiers remain compatibility identifiers. Renaming them requires a separate reviewed transition; branding alone must not invalidate records or keys. Public repository/domain changes are a publication task. The personal origin of the name is not included in public-facing copy.

## Audience

Adult caregivers coordinating health care for a parent or loved one. They may be stressed, unfamiliar with medical language, and working across time zones, hospitals, and family members.

Clinicians are not the primary users. Exports should be concise enough to share with them.

## Core job

Store original records and family notes on the right care days, retrieve the current source-linked history from any date, and let an authorized caregiver or their chosen agent inspect it without fabricated medical advice.

## The caregiver loop

1. Upload original files and unorganized notes; record when they arrived.
2. Place each item on its supported care day or leave it in “Date unclear.” Several files can share one day; empty days have no node.
3. A permitted family member checks placement and visibility. Approval is editorial, not medical verification.
4. Family members sign in separately to browse the same approved day history and source files.
5. An authorized agent reads bounded, cited records through MCP and traverses backward from any selected day using current data. Adeno does not store an AI-generated consensus.

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
