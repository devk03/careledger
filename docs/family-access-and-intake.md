# Family access and document inbox

The [treatment timeline product contract](treatment-timeline-product.md) defines what the inbox is for: source-grounded extracted entries that a person checks before they enter a shared chronology. The timeline, not a generated chat answer, is the canonical family record. Extraction is not care advice.

Proposed product behavior, 2026-09-22. This is a design for the MCP-first product, not an implemented hosted feature. The working community app currently has one owner login and a basic upload/review/timeline foundation. No new schema or migration was created by this plan.

## One family space, individual adults

A family space contains one loved one's records, a shared approved timeline, approved family updates, questions and tasks. Each adult has their own account and device authorization. The patient or an appropriately authorized caregiver decides who can join; an admin role inside software does not itself establish authority to share someone's health information.

| Role | Can see | Can do |
| --- | --- | --- |
| Family admin | Shared approved information and working material | Invite/revoke members, manage family settings, and perform editor actions. |
| Editor | Shared approved information and working drafts | Upload files, write notes, correct proposals, approve a timeline item or family update, and manage shared tasks. |
| Member | Shared approved information and their tasks | Read approved updates and sources, ask questions, submit new files or notes as proposals, and complete their own tasks. Cannot inspect other members' working drafts or publish timeline changes. |

Initial sharing is family-wide for approved records. The invitation screen must say that joining grants access to the existing approved history, including source pages behind summaries. Per-person exclusion of a particular approved document is a later feature; do not imply it exists through a hidden button. A person's preferred explanation length changes presentation, not permission.

Join flow: admin enters the adult's address → one-use, expiring invite → invitee creates/signs into their own account and enrolls a device → admin verifies the intended recipient and grants the approved-content key → membership becomes active. A separate grant is needed for editor working material. Every read, download, search, task action and MCP request checks current family membership and role. The connected AI client's grant is narrower still: `membership ∩ item visibility ∩ client scopes ∩ keys available on that device`.

After joining, each adult sees **Copy setup instruction** in their own account. They paste the short public instruction into their agent, which adds adeno through MCP and opens the browser authorization prompt. Linking an AI app is a personal authorization, separate from accepting a family invitation. The [first-login connection flow](mcp-first-product.md#connect-your-agent-the-first-login-flow) defines the setup and disconnection experience.

With family-controlled encryption, separate approved-content and working-draft encryption domains are required if members must not decrypt other people's drafts. A member needs a way to submit a file encrypted for the editor/review group without receiving every editor-draft key. A single household key cannot enforce these distinctions. Role checks on the server prevent unauthorized publication, while scoped key grants protect read confidentiality. On removal, revoke sessions, devices and MCP grants, rotate affected keys, and stop serving older encrypted copies. Previously downloaded pages, exported files, old keys and copies held by an AI provider cannot be recalled. Recovery and last-admin loss must be solved before hosted access to real records.

## The web document inbox

The primary web action is **Add records or a note**. A caregiver can drop several PDFs/photos at once, paste unorganized text, or do both. The inbox shows upload progress, duplicates, unsupported or unreadable files, and whether a document is still being processed. A user can leave and return without losing the original or the review state. The original file is preserved; extracted text and thumbnails are derived copies.

First screen: one large drop area and an “Add a note” box, with a persistent inbox below showing each file's status. Selecting a file opens the original page beside extracted type, date and facts; on a phone, a clear Source / Extracted information switch replaces the side-by-side layout. An editor can correct an extracted entry there, then open the resulting timeline before sharing it. The interface should use plain status words such as “Reading pages,” “Needs your review,” and “Added to timeline.”

The inbox should ask for only what the caregiver knows: “What was this about?” and “Which day did it happen?” are optional. Missing answers remain unknown. File details keep the care day, date printed on the document, and upload timestamp distinct. The main timeline shows days, not upload times or an hour-by-hour history. The system never silently treats upload time as the treatment date.

### Processing stages

1. **Admit safely.** Check type, size and file signatures; isolate parsing; hash the original for duplicate detection. On the hosted E2EE path, the browser/device encrypts the original before upload, and only an authorized device handles readable pages. Current community intake is not this E2EE path.
2. **Read the pages.** Extract embedded text where possible; use OCR for scanned pages. Preserve page number, quoted span and confidence/legibility flags. A failed page stays visible for human transcription rather than being silently dropped.
3. **Classify the document.** Extract document type (for example imaging report, lab result, clinic note, discharge paper), source organization, patient identity, document date and any supported care day. Mark uncertain classifications for human review. Neither a filename nor a classifier is proof of a diagnosis.
4. **Extract source statements.** Capture findings, measurements, explicitly documented clinician instructions and appointments with exact page pointers. Keep source wording separate from a plain-language restatement. Contradictions remain side by side; old accepted facts are not overwritten. Do not generate new clinical questions, tasks or advice.
5. **Arrange by day.** Place each checked source statement on its supported calendar day and attach all relevant files and notes to that day card. Create a day card only when there is material for it; never prefill empty dates. Multiple files can share one day; one document can discuss several days. Do not create nested event records or treatment-course groupings. If the care day is unclear, place the material in a “Date unclear / needs review” queue. The caregiver can correct the day while preserving revision history.
6. **Human review.** Show each classification, date, statement and proposed day placement beside the page. A permitted editor approves, corrects or rejects each extracted entry. Approval records who acted, when, what version and which source supported it; it is an editorial decision, not medical verification.
7. **Share and query.** Approved timeline items and family updates become visible to readers. A local authorized MCP companion can answer from that approved set with citations. Drafts, rejected proposals and unrestricted raw files are not searchable by ordinary readers or AI clients.

If an external model is used for classification or explanation, the UI must first name the model/provider and the exact selected content that will leave the device. Family-controlled encryption does not prevent that chosen AI provider from seeing the content sent to it. A server-side background classifier that needs decrypted records is incompatible with the current ciphertext-only hosted promise; the first private implementation should run on an authorized device or use a separately approved client-side transfer. Manual entry remains usable without AI.

## Example, wholly fictional

An editor uploads a fictional clinic note and a lab PDF on Tuesday and writes, “We discussed the follow-up, but I cannot remember the date.” The clinic note documents a Monday visit; the lab result is dated Wednesday; the upload was Tuesday. adeno extracts the Monday visit and Wednesday result as separate dated entries, marks the follow-up date unknown, and links each statement to its page. The editor checks the grouping and approves the timeline. A reader then asks their connected agent, “What changed this week?” and sees only the approved entries, source links, and the unresolved date—without a recommendation for what to do next.

## First delivery slice and gates

Prototype the inbox and review flow with wholly fictional files: batch upload, rough note, progress/failed/duplicate states, extracted type/date/day placement, undated queue, page-linked corrections, and one approved timeline with multiple files on one day. Prove the same accepted timeline is shown in the web view and through an authorized local MCP read tool. Then add individual adult accounts and family membership with cross-family denial tests. Design separate keys for approved content and editor drafts before claiming reader privacy. Any additive database schema or migration requires explicit maintainer permission before creation or application.

Security references: [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [file uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), and [prompt injection](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html). These support the need for per-request checks, safe file admission and treating document text as data rather than agent instructions.
