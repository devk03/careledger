# Proposed managed v11: proof-first email signup

Status: design for approval only. No `0011` SQL file has been created or
applied. The existing managed v10 and community databases are unchanged.

## Why this change

V10 signup inserts a pending account and frozen family before email ownership
is proved. `managed_accounts.login_email` is globally unique and immutable,
and account deletion is forbidden. Merely expiring a later token cannot release
an email reserved this way. Public signup must not mount on that path.

V11 should keep an unverified request outside `managed_accounts`. Only the
email recipient's proof creates an active family, verified account and active
owner membership. The recipient chooses the password **at verification**, so
someone who requested a token for another person's email never selects that
person's eventual password. Verification returns the new opaque household ID,
not a login cookie; normal login then requires that password.

## Exact proposed migration scope

Create only `server/migrations/managed/0011_email_signup_proofs.sql`, register
its checksum/version in the separate managed manifest, and add:

- `managed_email_signup_proofs` (STRICT): random opaque ID, normalized recipient
  email, unique SHA-256 digest of a 256-bit random bearer token, issue/expiry
  times (at most 30 minutes), nullable one-time consumption time, nullable
  activated household/account IDs, and nullable receipt expiry (at most ten
  minutes after consumption). The four result fields are either all absent or
  all present. Composite foreign keys bind a consumed receipt to the newly
  created membership. Add an email/expiry index for bounded issuance checks.
  The email is server-visible identity metadata, not an encrypted health
  record. Retain it only as long as the proof/abuse policy requires; redact it
  from logs and metrics. An email HMAC alone cannot supply `login_email` during
  activation. Encrypting the address at rest would require a separately
  managed application key and a stable keyed lookup digest.
- Insert/update guards: reject malformed or expired issuance, changes to token,
  email or times, a second consumption, and consumption unless a matching
  newly verified active account, active owner membership and active family
  exist. A consumed proof may be read only until its receipt expiry; it never
  issues a session. No SQL row contains the raw bearer token or password.
- Account guards: reject `state='active'` with `email_verified_at IS NULL` on
  future inserts and updates. Do not change any v10 account email uniqueness,
  deletion or immutability rule.

This is additive; it does not rebuild or drop a table. The v11 application
preflight must reject a database with any legacy pending managed account or
frozen signup family. Those rows cannot be reclaimed by simply disabling or
expiring them; an explicit, separately reviewed conversion would be needed.
The approved v10 fictional source is empty, but the preflight still needs a
test. No migration may run on community, Hermes, Railway or real-family data
under this proposal.

The preflight is a release condition, not a cleanup step. A legacy pending
account still owns its unique `login_email`; neither expiry nor disabling it
releases the address. Do not silently convert, delete or bypass such rows.

## Required service and route behavior after schema approval

1. `POST /signup` takes an email, not a password. Under shared IP/email limits,
   issue a random token, store only its digest, and pass the raw token to an
   injected email sender. Return the same generic acknowledgment for unknown,
   existing and newly requested addresses, without timing or error details
   that reveal account existence. Delivery failures must not create an
   account; the recipient can request another proof after the limiter allows.
   Set a bounded outstanding-proof count and resend interval. The sender must
   not place the bearer token in URL query parameters or logs.
2. `POST /verify-email` takes the bearer token and a recipient-chosen password
   via bounded same-origin JSON, never a GET link that scanners can consume.
   Hash the password outside the SQLite write lock with a memory/concurrency
   bound. In one `BEGIN IMMEDIATE` transaction, recheck token expiry and
   one-use state, reject any existing account for that email, insert the active
   family, verified account and active owner membership, then consume the proof
   and record the short-lived receipt. Uniqueness makes simultaneous valid
   proofs for one email yield at most one family. If a future compatibility
   path activates existing pending rows, it must advance account and membership
   `auth_version` as required by v10 triggers; this v11 path does not do so.
3. A retry of the *same consumed token* during its receipt window returns the
   same household ID, without changing the password, inserting rows or setting
   a cookie. Other failed/expired/replayed proofs receive generic responses.
   Existing active accounts use a separate login/recovery flow; email signup
   must never reset their password or add a membership.
4. The current verification contract returning only `householdId` is
   insufficient: the service needs token, recipient-chosen password, normalized
   email binding and a replay-safe outcome. The existing `registerPendingOwner`
   path must remain unmounted and the web signup/verification UI must switch to
   this proof-first contract. Durable resend bounds, generic timing,
   token/password redaction, recipient-address policy and retention are release
   gates. Neither proof creation nor consumption issues a session, device
   authorization, profile or record access.

## Fictional proof before any release

Apply v11 only to a new disposable private clone of the approved empty v10
fictional database, after explicit permission. Test same-origin transport,
expiry, wrong recipient, replay, lost-response receipt, two-token race for one
email, existing active account, failed-send/retry, malformed bodies, transaction
rollback, zero legacy pending-row preflight, verified login, cross-family denial
and no raw token/password/email in HTTP errors or captured logs, no raw token or
password in the DB, and no household IDs in limiter keys. Confirm that a
consumed-token retry with a *different* password cannot replace the first
password; proof consumption cannot itself create a session or authorize a
device. Test registry checksum and version rejection, too. Run schema
integrity/FK checks and the full privacy audit. A sender credential, billing,
production application or PR merge needs separate approval.

## Still not solved

This does not activate a device, deliver email without an approved provider,
provide a distributed limiter, implement owner-key recovery, mount managed
E2EE uploads, or make Adeno ready for real health records.
