# Fictional Chromium draft-pair HTTP proof

Status: isolated test only; managed intake remains disabled in the deployed app.
The guarded [runner](../server/test/managedFictionalBrowserDraftPair.mjs) reads
only the checksum-pinned, empty, separately approved local v10 database and
copies it into a new private temporary fixture. No migration is applied by
this runner. Its Express server binds to an ephemeral loopback port and mounts
the existing managed candidate routes only in that process, with Vite serving
browser modules from the same origin after the API routes. The production
server is not changed.

In Chromium, invented device keys are generated as non-extractable WebCrypto
keys. Only their public bytes seed the fictional enrollment rows. A test-only
one-use login endpoint sets the real Secure, HttpOnly, SameSite cookie; it is
not an implementation of public signup or device enrollment. The browser
creates a draft-purpose key and envelope, reserves opaque IDs, encrypts an
invented family note, binds both ciphertext intents, opens leases, and saves
both exact wire digests in the local upload journal before POST. The first
upload is committed by the server but its response is deliberately lost;
the journal checks the exact receipt instead of resending the intent. After
both receipts, the browser opens and verifies the encrypted draft, signs the
pending-pair context, and submits the same signed body twice. The second
submission is an idempotent readback, not a new pair. A second fictional
family cannot read the first family's receipt. The browser checks that a
wrong CSRF token and omitted cookie cannot reserve a pair, that its accepted
cookie is Secure/HttpOnly/SameSite=Strict, and that its API mutations carry
the expected Origin. A page reload reconciles both receipts without another
upload. No care-day revision is published.

The test checks API URLs, headers and bodies, copied DB/sidecars and referenced
object bytes for literal and common encoded forms of its invented note marker,
care date and author label. The committed wire digests and lengths must match
the browser's locally saved ciphertext journal, while the browser signer
decrypts and authenticates both wires. Those checks support a narrow
ciphertext-content claim; they do not prove arbitrary plaintext cannot leak
through another representation or surface. It verifies the source DB hash
and absence of source WAL/SHM sidecars at both ends. It does **not** inspect
logs, every orphan, backups, or the built production JavaScript. The browser
runs scripted modules through
`page.evaluate`, not a caregiver-facing form. Enrollment, grants and key
activation are structurally seeded, not owner-approved with real signatures.
Keys and encrypted wires are lost on reload; only receipt reconciliation is
proven. PDF/photo safety, durable signed-payload retention, abandoned-lease
recovery, physical quota, public signup, consent, MCP access, and deployed
route activation remain open launch gates.
Wrong-Origin rejection and more extensive abuse cases are covered by the
separate fictional Node HTTP test; a browser cannot set an arbitrary Origin
header on a same-origin fetch.

Run only after separate approval for an empty fictional local migration
application and with the exact source path printed by that approved runner:

```sh
npm --prefix server run build
cd server
ADENO_APPROVED_FICTIONAL_MIGRATION=1 node test/managedFictionalBrowserDraftPair.mjs /absolute/path/from-the-separately-approved-runner/managed.sqlite3
```

The checksum is pinned in the runner. Never substitute a production, Hermes,
community, or family database. Retained test copies contain invented data and
are not automatically deleted.
