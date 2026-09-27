# Fictional browser device enrollment and binding proof

Status: isolated, test-only. No managed device or auth route is mounted in the
deployed app. No real family account or record may use this path.

The guarded [runner](../server/test/managedFictionalBrowserDeviceEnrollment.mjs)
reads only the checksum-pinned, empty, separately approved local v10 database,
then copies it into a private temporary fixture. It applies no migration and
never writes the source. A loopback Express server mounts the existing managed
auth/device candidate routers before same-origin Vite middleware; its rate
limiter and credential-bucket key are ephemeral fictional test inputs, not a
deployable abuse-control configuration. The production server is unchanged.

Three Chromium contexts use the real managed login route and Secure,
HttpOnly, SameSite=Strict session cookies: a candidate owner session, a
separate approver session for that owner, and an unrelated family. The
candidate reads a fresh authenticated `/session` view, generates non-exportable
X25519 and Ed25519 keys, sends only public keys for an enrollment challenge,
validates the challenge against that session and current origin, computes a
local comparison code, and signs/submits the proof. The device becomes pending
and cannot bind yet. The unrelated family and an incorrect code fail owner
approval; the separate owner session then submits the candidate's code and
its fictional password to activate the device. The candidate signs a fresh
session-binding challenge with the same in-memory Ed25519 key. The database
contains one binding. An altered enrollment nonce and binding signature are
denied; repeated submissions are denied and both consumed challenge rows are
checked. A repeated binding request may also be stopped by the
one-binding-per-session guard, so this does not isolate every one-use layer.
A missing cookie and wrong CSRF token are denied. A separately issued,
independently signature-verified binding proof is denied after device
revocation without consuming its challenge; a new challenge is denied too.

This is a browser-to-HTTP serialization, WebCrypto, cookie, session and v10
transaction proof, not a user-facing onboarding flow. Account activation is
structurally seeded in the copied fixture; public signup/email verification is
not exercised. The code transfer between browser contexts is scripted, not an
observed human comparison or approver audit. Keys are not saved in IndexedDB,
so reload, browser loss and recovery are unproven. A test-only in-process
limiter does not prove distributed abuse protection. V10 stores no approver
identity. No medical content is uploaded in this test. The independently
permission-gated [device-key store](managed-device-key-store-proposal.md),
approval UI, signup, recovery and complete E2EE/grant paths remain launch
blockers.

The guarded fictional run passed on 2026-09-27. It remains a manual test,
outside the ordinary `npm test` suite because it requires the separately
approved local fixture; this is not release CI evidence. Wrong-Origin
rejection is covered by the focused device-router HTTP tests, not by this
browser runner.

Run only after separate approval for an empty fictional local migration
application, using the exact source path printed by that approved runner:

```sh
npm --prefix server run build
cd server
ADENO_APPROVED_FICTIONAL_MIGRATION=1 node test/managedFictionalBrowserDeviceEnrollment.mjs /absolute/path/from-the-separately-approved-runner/managed.sqlite3
```

The runner pins the empty database SHA-256 and private temporary location.
Never substitute a production, Hermes, community, or family database. Its
invented test copy is retained for inspection, not automatically removed.
