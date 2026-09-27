# Managed device approval candidate (v10, unmounted)

Status: fictional local proof only. Do **not** mount this endpoint on a public
or real-family deployment.

Enrollment proves possession of the candidate device's encryption and signing
keys, then stores that device as `pending`. It does not authorize access. The
approval candidate requires an active, email-verified owner session with
same-origin cookie/CSRF preflight, current owner password reauthentication and
a comparison code computed by a browser-side helper from the candidate's
locally held keys, household, account and device ID. The adult must read that
code from the candidate device and enter it in their own session. Server-supplied
autofill would defeat the comparison. The code is not secret and cannot grant
access without the other checks.

After password verification, one immediate SQLite transaction rechecks the
owner session, unchanged password hash/auth versions, target household and
account, unchanged enrolled keys, consumed possession proof, pending state,
unexpired challenge and live original enrollment session. It activates exactly
one device; a replay fails. An owner can approve their first device or an
active member's pending device, including a child's. A child cannot approve a
device. The current service and HTTP router are intentionally unmounted.

The v10 challenge expires within ten minutes and its original session must
remain live. An expired pending device cannot reuse its keys because the schema
keeps unique key constraints; the person must generate fresh keys and enroll
again. V10 stores `activated_at` but neither approver identity nor proof of
password reauthentication. Its activation trigger alone is **not** a human
approval audit. Public release still needs an approver audit design, a real
manual comparison UI, deployed shared rate limits, trusted proxy/origin policy,
the proof-first signup service, recovery and full E2EE grant tests. The helper
is not yet connected to a user-facing enrollment screen.

Password plus a live owner session can approve another device in this
candidate; an existing trusted device does not co-sign that decision. Public
release needs an explicit policy for subsequent-device co-approval or an
audited recovery ceremony. Activation alone does not distribute old record
keys, but it must not be presented as protection against a stolen owner
password and session.

The guarded fictional acceptance script reads the exact approved empty v10
local database, writes only to a private copy and applies no migration. It
tests first-device and child-device activation; wrong password/code, CSRF,
non-owner and cross-family denial; expiry, owner/original-session revocation,
replay, two-connection competing calls in one process, and password/target
membership/device changes during reauthentication. It seeds a structurally
consumed enrollment proof with a fictional signature for some cases. The first
owner device goes through the real enrollment proof verifier before approval.
Its approval request then uses the real local HTTP router and SQLite service;
the same device completes a signed session binding afterward.
This is not a browser-UI enrollment test or a two-process
lock-contention race.
The source database's hash is checked before and after.
