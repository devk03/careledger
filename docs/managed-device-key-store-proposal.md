# Proposed browser device-key store (approval required)

Status: design only. No IndexedDB database/object store has been created or
upgraded by this proposal. Do not use real family data to test it.

The browser now has a migration-free pre-save validator for the exact
challenge/session/origin, both local public keys and both private-key
operations, with a bounded 60-second clock-skew allowance. The enrollment
and session-binding wire signers require a separately supplied authenticated
session/device expectation and reject conflicting wire claims. This does not
establish that a caller actually obtained that expectation from a live session;
the managed UI and durable key store are still absent.

## Why it is needed

The browser can generate non-extractable X25519 and Ed25519 device keys and
prove possession, but the current keys live only in memory. A reload can lose
them after the server has enrolled the corresponding public keys. Device-held
decryption and signed actions cannot be reliable without local persistence.

## Exact first schema and contract

After explicit permission, create browser-local IndexedDB version 1 with one
`device_keys_v1` object store and unique composite key
`[householdId, accountId, deviceId]`. One record atomically holds both
`CryptoKeyPair`s, the exact validated nonsecret enrollment challenge wire,
their raw public-key digests, a format version and its canonical 32-hex IDs.
V10 stores only the challenge's derived nonce hash, not the ephemeral public
key from its wire, so the server cannot reconstruct that wire after a reload.
No raw/PKCS#8/JWK private key bytes, medical data, password or server
credential belongs here. Do not add an automatic upgrade, deletion or
overwrite path in this slice.

The public browser API should expose only exact-tuple save-once and exact-tuple
load; it should not provide a list-all operation. The caller must supply
household/account from its authenticated server session and `deviceId` from a
validated enrollment challenge, never from an untrusted URL or free-text field.
The API validates algorithm, usages, non-extractability, key-pair possession,
and both public keys against that exact stored challenge or a later
authenticated server device record. On duplicate `add`, return the stored
record only if identity, challenge wire and both public keys match and the
stored private keys still work; otherwise fail closed. Never silently
regenerate or replace a trusted pair.

## Enrollment order

1. Generate both non-extractable keypairs on the device.
2. Send **public keys only** to request a challenge. This step must precede
   persistence because v10 assigns `deviceId = challengeId`; no local code can
   know the canonical storage key earlier. A crash here leaves only an unused
   server challenge, not an enrolled device.
3. Validate the returned challenge's household, account, keys and expiry
   against the authenticated session and locally held keys. The wire has no
   origin field: validate the trusted current/deployment origin separately;
   the enrollment proof binds its digest as `audienceSha256`.
4. Atomically `add` one complete IndexedDB record, including the exact
   challenge wire. Wait for transaction completion, then load it back and
   verify the exact tuple, public keys and private-key operations. Do not
   await Web Crypto inside an open transaction.
5. Sign and send the possession proof using the **reloaded** keys. If storage
   fails, abort enrollment rather than continue with ephemeral keys.
6. Await human approval and bind the approved device to the session. A future
   authenticated server read endpoint may help locate a live challenge ID
   after reload, but it cannot reconstruct the wire; resume uses the exact
   saved local wire while unexpired. Never remap an expired challenge's old
   local keys to a new `deviceId`.

## Required fictional Chromium evidence

Use newly invented IDs and keys. Generate, store, reload, sign and derive;
reload the page and repeat. Assert both private keys remain non-extractable,
the exact public bytes match, and no private material enters a request or log.
Exercise two unrelated families, the same `deviceId` in different households,
wrong account/keys, duplicate and competing-tab `add`, transaction abort,
storage unavailable/quota error, and reload after a committed-but-unacknowledged
write. A failed or uncertain save must never submit a proof with an unsaved
pair. A persistent-profile browser restart and alternate-origin isolation are
separate release checks, not inferred from a page reload.

## Limitations and release gates

IndexedDB is scoped to the exact origin and browser profile. Clearing site
data, browser/OS loss, private browsing or eviction can lose the keys; this is
not backup or owner recovery. Non-extractability prevents exporting raw key
bytes through the Web Crypto API, but same-origin JavaScript can still **use**
the keys. Malicious operator-served JavaScript, XSS or a compromised browser
profile therefore remains a material threat. Exact-tuple lookup helps an
honest client avoid cross-family mistakes; it is not a cryptographic barrier
against malicious same-origin code. Public readiness still needs recovery,
revocation/rotation, a manual approval UI, release integrity, and complete
encrypted grant/read flows.
