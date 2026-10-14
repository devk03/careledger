# Hermes private MVP

Target origin: `https://adeno.kunjadia.dev`. This is a trusted, server-readable
private deployment, with public signup and invitations disabled. It makes no
managed E2EE claim. Do not import real case records into the repository.

The candidate entrypoint is `server/src/runPrivatePilot.ts`. It requires an
existing private v7 database and never initializes or migrates one. The
container binds to Hermes loopback port 8091 through Compose; Nginx supplies
HTTPS on the exact configured origin. Existing sites must remain intact.

## Operator preparation

1. Point the hostname's A record to Hermes (`68.183.163.198`). Verify DNS before
   issuing a certificate or publishing a connection instruction.
2. Obtain separate migration approval for the exact new database and schema.
   Use a new private synthetic database first. Preserve existing databases.
3. Prepare the data directory with mode 0700, owned by container UID/GID 10001;
   the database and sidecars must have mode 0600. Keep it outside the checkout.
4. Set `ADENO_RELEASE_TAG` to the reviewed image tag and
   `ADENO_PRIVATE_DATA_DIR` to that absolute directory. Do not place secrets in
   Compose, Git, screenshots or shell command arguments.
5. Build with `docker compose -f compose.private-pilot.yaml build`. Startup is
   unavailable until the approved database exists. The private bootstrap token
   is stored under `/data/secrets/bootstrap-token`, never in container logs.

## Current verification limits

The private note-review API returns a proposed note only to an authorized adult
reviewer, with the current day revision for stale-edit protection. Ordinary
history and MCP do not return proposals. HTTP tests cover authentication,
generic denial, freshness and uncached responses. SQLite permission tests need
separate approval to apply existing migrations to synthetic test databases.

Feature commit `16f6cba` built on Hermes into `adeno-private:16f6cba`, image
manifest `sha256:cbb5dbd7754770592ffc4a7a220d357ac6c4bb554a7ab5261a00de5c0cde7673`.
A network-disabled, read-only, non-root container loaded SQLite and verified a
synthetic Argon2 hash. This proves native runtime compatibility, not app startup.

The `/pilot` UI now implements the v2 login/setup, note-proposal and explicit
review APIs, using the existing component library. UI tests verify password POST
handling and publication only after reviewing the actual proposal with its
observed day revision. Profile creation now has an owner-only transactional
writer, Origin/session/CSRF preflight route and UI form. HTTP/UI tests cover
request boundaries and selecting the newly created profile. Database-backed
ownership, audit and revocation assertions await migration approval.
Durable file intake and complete history pagination remain work.

HTTPS, connector setup, encrypted off-host backups, restore and deployed
acceptance remain unproven. DNS configuration is deferred to the maintainer for
October 15. This document is a runbook candidate, not a readiness claim.
