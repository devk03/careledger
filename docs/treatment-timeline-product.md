# adeno: treatment timeline as the product

Product direction, updated 2026-09-24. The web timeline is adeno's primary interface: families drop files and notes, check extracted record entries, and see the history of one loved one's treatment. MCP is another way for an authorized family member's agent to query that same history or submit new source material for review. [Per-day grants, child approval, and published node snapshots](day-access-and-history.md) refine the earlier access and storage assumptions. This is a proposed product contract, not a claim that the current app already implements it.

## The job

After a treatment, appointment, test or new result, an authorized family member can drop the related files and a rough note into adeno. Each upload gets an immutable received-at timestamp for provenance. A person chooses or checks the care day and attaches the material there; several files and notes can belong to the same day. If the day is unknown, the material stays in “Date unclear.” The original and later corrections remain available. Automated reading or summarization is optional, not required to store, browse or query the history.

The questions adeno's data interface must support are: **What records were attached to this day? What was recorded before it? What changed in the stored history? What is still undated or unclear?** An authorized connected agent may explain what a record says, citing the source page or labeling a family observation. Adeno itself does not infer that a planned treatment happened because its scheduled date passed, or recommend treatment, tests, appointments or next steps.

## The smallest useful information model

| Item | Meaning | Rule |
| --- | --- | --- |
| Source | An immutable uploaded file or family note | Preserve original bytes, provenance and upload time. A note is user-attested, not a clinical report. |
| Day node | One calendar-day entry in the visible timeline | Create it only when that day has a file, note or checked information. It can hold many files; a file that documents different days can be linked to more than one day. Do not pre-create empty nodes. |
| Undated item | A source or statement without a reliable clinical date | Keep it visible in “Date unclear” until a person can place it; never substitute its upload date. |
| Update | A versioned, human-authored account of what changed since the previous review | Optional. It is a view of checked day entries, not a second independent set of facts or a required model-generated artifact. |
| Task or question | An explicit clinician instruction transcribed from a source, or an item a family member chose to record | Keep owner, reason, due date if known, status and provenance. Extraction alone does not create or assign a task. No AI-originated clinical task. |

Dates must stay distinct: the day something happened or is documented as planned, the date printed on a document, report finalization date when known, upload time, and approval time. The timeline shows calendar days, not an hour-by-hour history. Upload time is retained in file details and the audit trail, not used to order care. A partial or contradictory date stays partial or disputed; it is not forced onto an invented day.

**A node is one day, not a separate clinical event model.** It has a calendar date, a short source-faithful account of what the records say for that day, attached files/notes, page citations, and revision history. If a day contains several documented facts, show them together within that day without creating nested event objects. Mark a statement as planned, occurred, cancelled or uncertain only when the source or family attribution supports that status. A document can be attached to multiple days if it actually discusses multiple dates; the date printed on a report does not automatically become the date of care. If a date has no node, it means **nothing has been recorded in adeno for that day**—not that no care occurred.

The visual timeline should show only populated calendar days in chronological order, with gaps left as gaps rather than rows of empty cards. It is not an hour-by-hour log, graph or treatment-course hierarchy. A day card expands to show its files, notes, source pages and “What changed here?” history. Do not show an overall medical “percent complete”; plans may change. Simple filters can help people find days with treatments, results or visits without hiding uncertainty.

**Context from any day:** every day card offers “History up to this day.” Starting with the selected day, traverse the populated day cards backward to the earliest recorded day and return current records, notes, dates and provenance in bounded sections. The user's chosen agent can synthesize that source material; Adeno need not store a generated consensus. Keep planned, completed, cancelled and uncertain statements distinct; show contradictions and gaps rather than smoothing them into a story. A newly uploaded file about an earlier day appears on the next read after review. Therefore label this view “currently recorded history through [date],” not “what the family knew on [date].” A true knowledge-at-the-time view would also need an upload/approval cutoff and is a separate feature.

## The five screens

1. **Timeline:** the default signed-in view and main visual interface. At the top, show a dated “Where things stand” brief drawn from checked day entries: latest documented treatment, upcoming documented plan, what changed, and open uncertainties. Below it, show day cards in chronological order and a “Date unclear / needs review” section. Visually distinguish documented facts from family recollections and planned items from completed ones. Each day opens its files, exact sources, change history and linked family tasks, plus “History up to this day.”
2. **Add information:** a persistent file drop plus a rough-text box, available from the timeline or a specific node. Accept multiple PDFs/photos, stamp each item when received, show per-file parsing/duplicate/failed states, and let the member leave without losing work.
3. **Check day placement:** original file beside its selected day, document date, upload time and any optional extracted text. An editor can correct the placement; OCR uncertainty and conflicting sources stay visible if extraction is enabled. The screen does not suggest care actions.
4. **What changed:** a deterministic list of newly attached files/notes, corrected dates and revised day entries since the last visit. A family member can write an optional update; there is no mandatory AI-written brief.
5. **Family & connections:** individual logins, roles, invitation and revocation, encryption recovery, and one **Copy setup instruction** action for each adult's agent.

Mobile can stack the source and extracted-information panes, but the actions and source links must stay available. Do not add a separate chat dashboard, billing dashboard or research portal to the first release. The website is the primary visual surface; MCP gives an agent a second, permission-checked way to interact with the same approved history.

## What happens after a file dump

File/note → immediate upload timestamp and safe intake → member-selected care day or “Date unclear” → review of placement and visibility → day card with one or more original files/notes → fresh, permission-checked HTTP/MCP reads. Optional text extraction can add a derived, source-linked layer later; it cannot replace the original.

No model is required for core use, and model output never becomes an approved day entry automatically. If a clinical date is uncertain, label it unclear for review rather than inventing a value. Every extracted clinical statement points to an original page; a family recollection carries its author and date instead. Optional explanations may restate what a source says and define terms; they cannot add diagnoses, predictions, urgency, or recommendations.

Authorized family members can ask an MCP-connected agent what the records say on a day, which files support it, what changed between days, what the currently recorded history is through a selected day, or what remains unknown. The backward-context query uses the same inclusive day cutoff and approved sources as the web view; long results are paginated or summarized with a way to inspect every included day. Responses use only permitted, approved day entries and bounded page citations. An editor may see that new uploads are awaiting review, but the agent must not present their unreviewed contents as established history. A member may submit a new note or file through web intake; later MCP write tools may submit material for review, never publish a day entry or replace its sources without review. The agent and web UI must read the same day IDs and revision history so they cannot tell two different stories.

For hosted family-controlled encryption, plaintext OCR, classification, review and search must run on an authorized device or use an explicit, approved transfer to a selected model. The hosted server cannot silently decrypt files to build the timeline. A cloud MCP client cannot be promised private-record answers until its device-side sharing path is demonstrated. The [E2EE boundary](e2ee-managed.md) remains binding.

## Fictional acceptance example

On Thursday, an editor uploads a fictional therapy-session note documenting a Tuesday session and a result report finalized Wednesday. The app extracts those two documented entries, even though both files were uploaded Thursday. A rough note says, “I think the next session is Monday”; that remains a family-attested, **unconfirmed** date, not a confirmed appointment. The editor checks the source pages, corrects one date, and approves the two documented entries. Another adult asks their connected agent, “What changed this week?” and receives the approved entries with page citations and a clear note that the next date remains unconfirmed. The agent does not suggest what treatment should happen next.

## Release cut and measures

- First useful slice: one care profile, batch inbox, rough notes, manual day placement/correction, reviewed timeline, undated queue, and deterministic “what changed” view. It must work without AI.
- Add optional OCR/text extraction only after original-file access, day placement and provenance work reliably. A later optional bring-your-own-key model may update a clearly derived summary when a day changes; it is not the source of truth and must never be required to read history.
- Give each adult their own approved timeline view and agent connection only after membership and key boundaries are enforced. A read-only local MCP proof may use fictional data earlier.
- Success is demonstrated by a wholly fictional multi-upload journey: two files attach to the same calendar day; another source goes on a different documented day; no empty intervening day nodes are created; “History up to this day” excludes later care days but includes reviewed earlier-day records even if uploaded later; upload time never becomes a care date; planned and occurred statements stay distinct; every approved clinical claim resolves to a page; a correction shows its prior version; two authorized adults see the same update, and an unrelated family sees nothing.

Later: outbound reminders, calendar sync, trial discovery, broad research, donations and complex per-document sharing. Those ideas may build on the timeline, but do not define the core product.
