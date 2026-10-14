# Private Codex connection acceptance

This runbook is prepared, not executed acceptance evidence. It applies only to
the trusted, server-readable Hermes pilot. Use independently invented records
for the initial run. Never copy real records into acceptance fixtures.

## Preconditions

- Obtain explicit approval before applying migrations, including to synthetic
  databases. Production database approval is separate.
- Pass database-backed browser approval and revocation checks before enabling
  `ADENO_PRIVATE_AGENT_CONNECTIONS=verified`.
- Start the reviewed private runtime as `adeno-private`. Enable record adapters
  only after their integration checks pass. An image tool needs the parser socket.
- Sign in through HTTPS as the intended adult account. In the browser, approve
  read-only sharing and inspect the provider disclosure. The agent cannot grant
  itself access.
- Check that the local `hermes` SSH alias resolves to the expected host, using
  the existing verified host key. Do not disable host-key verification.

## Configure the actual client

Codex supports stdio MCP servers with a command and argument array, and allows
explicit startup/tool timeouts. See the [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Use the browser's current connection instruction. For manual configuration,
append the following server table to the intended client's private config only
after replacing `BROWSER_APPROVED_GRANT_ID` with its 32-character lowercase hex
ID. Do not overwrite other client settings. The ID is not a credential; the
existing SSH identity and live browser-approved grant are both required.

```toml
[mcp_servers.adeno_private]
command = "ssh"
args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "hermes", "sudo", "-n", "docker", "exec", "-i", "--env", "ADENO_MCP_TRANSPORT=ssh-stdio", "adeno-private", "node", "server/dist/runPrivateMcp.js", "BROWSER_APPROVED_GRANT_ID"]
startup_timeout_sec = 30
tool_timeout_sec = 60
```

Keep this config outside Git. Never include passwords, session cookies, recovery
codes, provider keys or record contents. A local configuration listing proves
only that Codex parsed the settings, not that tools work. Open a fresh client
session to load the server. The server exits after at most one hour; a renewed
browser approval and fresh connection are needed after expiry.

## Acceptance evidence

1. In the actual Codex session, call `get_connection_profile`. Verify the expected
   account, household and scopes, then use `list_care_profiles` to check visible
   profiles before reading any record. Check the
   trusted-server-readable disclosure and image availability. A failed or wrong
   identity is a stop condition; do not retry with another person's approval.
2. Ask for the independently invented approved care day. Inspect the actual tool
   result and confirm the day, revision and document/page/hash citation against
   the authenticated browser. A model's unsupported assertion is not evidence.
3. Ask to read its cited source. For PNG/JPEG, call
   `get_approved_source_image` through the client. Confirm an image is received,
   its original hash matches the browser, and its rendition hash/dimensions are
   present. Confirm the client distinguishes proposed interpretation from source
   evidence and does not diagnose, prescribe or assign a stage.
4. Confirm an unpublished document and a profile outside this grant return no
   evidence. Do not paste unapproved content into the prompt to perform this check.
5. Keep the same client connection open, disconnect in the browser, then attempt
   another history/source call. Verify denial from the tool result. Previously
   received conversation content remains with the client/provider.
6. Approve a new connection, verify it, sign out in the browser and repeat the
   denial check. Test expiry separately with controlled synthetic test time;
   do not leave a polling process running to wait for it.

Record release SHA, client version, time, synthetic fixture IDs, successful tool
names and denial outcomes. Record only minimal non-sensitive receipts. SDK
transport tests, mocked repositories and config parsing do not replace this run.

## Preparation evidence

Codex CLI 0.154.0 parsed this table's command, exact argument array and both
timeouts through temporary `-c` overrides with an invented grant ID. No client
configuration files were changed and no server was launched. The two focused
browser connection tests and lint passed after adding the SSH bounds and source
image disclosure. Actual initialization, evidence reads and live revocation
remain unverified.
