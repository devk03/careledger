# Day access and version history

Product decision for the private family pilot, 2026-09-24. **Design only; not implemented.** A node is one populated calendar day for one care profile. This replaces the earlier assumption that every approved day is visible to every family member. It does not authorize creating, registering, or applying a database migration.

## Provision people, not shared passwords

The family admin creates an expiring, single-use invitation for a named person. The recipient sets their own login secret; the admin never chooses, sees, or sends that secret. Membership starts with no record access. The admin then grants day access, individually or by selecting several days in one action. The admin can revoke an account or its grants, and the app records who changed access and when. A software admin role does not itself establish legal authority to share a patient's records; the family must make that decision.

For the first pilot, use three simple capabilities on each day: **view**, **contribute**, and **publish**. View reads the approved current day and its permitted history. Contribute submits a proposed file, note, or correction without changing what the family sees. Publish accepts a proposal or saves the adult's own checked edit as a new shared revision. Publish implies view and contribute. New members have no implicit day grants; batch granting is a convenience, not a bypass. Admin access management is separate from a member's day grants. A child account may be given view or contribute, but never publish. Teen/adult presentation settings do not silently change permissions.

An adult with publish access may publish their own human-authored note or checked placement directly. A child's submission always waits for an authorized adult to approve or reject it. Model-extracted clinical statements also remain proposals until an adult checks them against the source; merely having an adult account does not turn model output into a fact. Drafts are visible only to their author and permitted adult reviewers.

Every HTTP, viewer, search, export, and MCP read checks the current membership and the specific day grant. Hidden days must not leak through counts, cursors, search snippets, revision listings, or “history through day.” An agent receives no broader access than its connected person. Source-file access is a separate check: viewing one day cannot silently grant a whole PDF that also contains material from restricted days. The admin must explicitly grant the source or share an approved bounded excerpt; otherwise the source remains unavailable. Guessing a node, revision, or document ID never grants access.

## Snapshots without copying original files

Create no row for an empty day. On the first published item, give the populated day a stable identity keyed by `(care_profile_id, care_day)` and save snapshot 1. Every later published content change creates an immutable, complete snapshot of that day's approved state: ordered references to document placements, note revisions, source-linked statements, and their review statuses. The original file bytes remain immutable in the object store and are referenced rather than copied into each snapshot. A snapshot records its revision number, previous revision, actor, server timestamp, and a short reason or change summary.

The write request supplies the version the editor saw. If someone else published a newer revision first, reject the stale write and show a comparison instead of silently overwriting it. A child proposal or rejected edit is retained in the proposal/audit history but does not advance the shared day snapshot. Moving a file from one day to another updates the two affected day snapshots in one transaction after checking permissions on both days. If a day becomes empty, it disappears from the current sparse timeline; its authorized revision history remains inspectable.

The day card offers **What changed?** (a diff from the previous published snapshot) and **Earlier versions** (read-only, attributed snapshots). Current access rules govern historical versions too; revoking a day grant blocks future reads of old snapshots. Access-grant changes have their own admin-only audit history rather than rewriting medical content snapshots. Previously downloaded files or content already sent to an AI provider cannot be recalled.

This pilot uses the trusted Hermes server model: the server can read stored content. It is not the future family-controlled E2EE mode. E2EE would need a separate key/grant design before the same per-day confidentiality promise can be made for managed hosting.

## Acceptance checks before real family records

- Two adults have independent logins and different day grants; a child can submit a note but cannot publish it.
- A child proposal does not change the shared day; an authorized adult's approval creates exactly one new snapshot.
- A stale concurrent write cannot replace a newer snapshot; prior versions and actor/time remain intact.
- Revocation immediately blocks current and historical day reads, direct source links, downloads, search, and MCP.
- A file linked to a visible day and a restricted day cannot be opened in full without a separate source grant.
- Cross-profile and cross-family guessed IDs return no content or hidden-day counts.

Authorization should deny by default and check each object on each request; see [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [IDOR prevention](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html).
