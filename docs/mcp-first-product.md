# Agent connection for adeno

Current direction: the [visual treatment timeline](treatment-timeline-product.md) is the primary interface and canonical family history. This document details the MCP connection and agent capabilities alongside that web experience. Its earlier “MCP-first” language is superseded by the timeline product contract.

Decision recorded 2026-09-22. This is the intended product direction, not an implemented feature. The maintainer confirmed that hosted storage must remain family controlled and the server must not gain the ability to decrypt family records merely to support web-based AI clients. The existing community app has no MCP endpoint, no inbound MCP OAuth, no individual family accounts, and no managed end-to-end encrypted record flow. The current app remains useful as a local record workspace while this design is built.

## Product shape

adeno is the trusted record, timeline and family coordination layer. The website is where a caregiver drops files, views the day-by-day history, corrects day cards, checks source pages, approves updates and manages access. A compatible AI client can query the same approved timeline through adeno's narrowly scoped MCP tools and submit source material for later review. Website access remains fully usable without an AI client.

The core loop is: upload a treatment/visit/result and a rough note → review evidence → draft a family update → approve one version → each family member can ask their chosen client what changed and see their own tasks. A chat answer does not become the shared record; the approved version in adeno does.

The [family access and document inbox spec](family-access-and-intake.md) defines the web dump, classification proposals, human-reviewed timeline, and individual access boundaries behind this loop.

The [adult review inbox](agent-review-inbox.md) defines how a child proposal becomes visible to a permitted adult and their agent. MCP subscriptions are optional change hints, not a promise that closed AI clients will wake up or display a notification.

## Two separate connections, not a pile of keys

1. A person signs into **adeno** and joins a family. Their AI client connects to adeno through that person's OAuth authorization. adeno issues a scoped, revocable connection grant. The family admin cannot silently authorize another adult's AI client. The normal connection flow should be “Copy setup instruction → give it to your agent → approve adeno access in your browser → Done,” without copying an adeno API key.
2. The person signs into **their AI client** using its own account or plan. If that client supports MCP directly, adeno does not need the person's model-provider API key simply to answer through MCP. Some developer/CLI setups may require a provider key or paid API account; guide users to that provider's official setup and explain whose account pays before they connect. Never ask users to paste a provider key into chat, a support ticket, a URL, or adeno's MCP tool arguments.

Using a person's existing AI client may shift model costs to that client/account; it does not make adeno's storage, OCR, hosting, support or optional background processing free. The no-client fallback and funding model still need a defined budget.

### When a model-provider key is actually needed

The ordinary caregiver path gives the agent the public connection instruction below. It has no model key field. For a developer-run agent or direct API mode, offer the provider's official account/key instructions separately, explain plan/credit requirements and where the key will be stored. [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart), [Claude API authentication](https://platform.claude.com/docs/en/manage-claude/authentication), [xAI API quickstart](https://docs.x.ai/developers/quickstart), and [Muse Code authentication](https://dev.meta.ai/docs/muse-code/auth) are the current key setup references. These are model credentials for the chosen client, not adeno access tokens. A paid chat subscription is not automatically an API credit balance.

## Connect your agent: the first-login flow

Every adult links their **own** AI client after their first adeno login. The family admin cannot link an agent on someone else's behalf. The signed-in website has one prominent **Copy setup instruction** action. The person pastes it into whichever agent they use; the agent handles its own MCP configuration. No client picker or multi-step wizard is required on adeno's main path. The page also shows a plain status line: “No assistant connected,” “Connected to your account,” or “Private records enabled on this device.” A mere OAuth connection must never be shown as proof that an agent can read encrypted records.

Exact instruction template, with only adeno's verified public MCP URL substituted at runtime:

> Connect this assistant to adeno using its MCP server at `https://<verified-adeno-domain>/mcp`. Add it here, then open adeno's sign-in prompt for me to approve. Do not ask me for a password, recovery code, API key or medical file. Once connected, tell me which adeno account and access level you see. If this app cannot add MCP servers, tell me plainly.

This text contains no personal URL, bearer token, family/patient name, recovery material or documents. A client must still verify the server origin and complete OAuth; the instruction itself grants no access. The adeno page may offer unobtrusive client-specific help if the agent reports that it cannot install the server, but should not make users choose a provider before copying the instruction.

1. The person copies the instruction into their agent. The agent adds the verified adeno MCP endpoint using that client's supported method. If it lacks MCP support or cannot install a server, it says so and links to the appropriate client help; it must not request a secret as a workaround.
2. The agent/client triggers the standard browser sign-in. adeno verifies the person, shows the family they are connecting, the client name, and the exact proposed access: profile only, approved updates, tasks and/or bounded source snippets. The person approves the grant. The server issues a short-lived, audience-bound OAuth token; the client stores it using its own credential mechanism. The agent cannot approve its own access.
3. A harmless `get_connection_profile` call verifies the connection. The website and the client both show the account/family name and a “Connected” result. If it linked the wrong account, the person can disconnect and retry from the same screen. An “Ask your agent” example such as “What family am I connected to?” confirms the tool actually works without exposing health content.
4. For private records under managed E2EE, a separate **Enable private records on this device** step unlocks the family vault and asks what the chosen client may receive. The local companion, not the hosted adeno server, selects and decrypts permitted content. If this client cannot use a validated local sharing path, show “Account connected; private records unavailable here” and a compatible alternative. Never silently weaken encryption to make a green checkmark appear.
5. The same screen lists connected clients, granted scopes, last use and **Disconnect**. Disconnect revokes the grant and blocks future tool calls. Existing model conversations, downloads and provider copies are outside that revocation and must be disclosed at connection time.

Normal success target: a nontechnical adult with an already installed compatible client finishes in under two minutes by copying one instruction and approving one browser prompt, without touching a terminal, copying a secret or choosing an AI model. Test the actual instruction with each supported agent. Some clients require their own marketplace/admin enablement or cannot configure MCP from an agent message; the agent should identify that limit and offer the smallest manual step. [OpenAI OAuth requirements](https://developers.openai.com/plugins/build/auth), [Claude custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Grok Bot connector policy](https://docs.x.ai/grok-bot/teams-and-enterprises), and [Muse Code MCP login](https://dev.meta.ai/docs/muse-code/extending) are current integration references.

Connection acceptance tests: two adults from one family link separate clients and receive only their own grants; a third adult in another family cannot query either family's data; a removed adult's existing client fails immediately; a downgraded role loses draft access; a wrong-family connection is visible before any health content is returned; token expiry and refresh recover cleanly; unapproved record content never appears in the profile/health check; private-record status is not marked ready without a working local sharing path.

## Client onboarding, verified as of this decision

| Client | First connection path | Product note |
| --- | --- | --- |
| ChatGPT / Codex | adeno remote HTTPS MCP with OAuth; an OpenAI plugin can provide a discoverable path after review. Codex also supports MCP configuration in its CLI/IDE. | Availability and write permissions depend on the user's current surface, plan and workspace policy. Do not promise one-click availability to every ChatGPT account. [OpenAI plugin quickstart](https://developers.openai.com/plugins/quickstart), [OpenAI MCP auth](https://developers.openai.com/plugins/build/auth), [Codex MCP setup](https://developers.openai.com/learn/docs-mcp). |
| Claude | Custom remote connector and individual OAuth sign-in; local Claude Code can also add a remote HTTP MCP server. | Claude's remote connector uses Anthropic's cloud even when the person is on Claude Desktop. [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp). |
| Grok Bot | Install an allowed MCP connector through its Cursor-linked plugin/Marketplace path; validate the precise OAuth and deployment flow with a real test account. | Grok Bot is distinct from Grok chat. It uses a cloud computer and requires cloud data storage under its current account settings, so explain that boundary before sharing health content. Eligible plans are required. [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [Grok Bot setup](https://docs.x.ai/grok-bot/get-started), [connector policy](https://docs.x.ai/grok-bot/teams-and-enterprises). |
| Muse | “Muse” is ambiguous. Meta Muse Code documents remote MCP and browser OAuth login, but the intended product must be confirmed before writing user instructions. | Treat as an integration target pending that confirmation. [Meta Muse Code MCP](https://dev.meta.ai/docs/muse-code/extending). |
| Other clients | Standards-based Streamable HTTP plus OAuth 2.1; local community installations may offer a local companion. | Support is earned by a real interoperability test, not assumed from an MCP logo. [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). |

## Initial MCP tool contract

Read-only first. Keep results small and explicitly labeled. Every tool uses the connected person's identity and current family membership, never an `owner_id` supplied by the model.

| Tool | Result | Boundary |
| --- | --- | --- |
| `get_connection_profile` | Which adeno account/family is connected and scopes granted; no medical content. | Helps people notice a wrong family connection. |
| `list_timeline_days` | Calendar days with short source-faithful summaries, file counts and opaque IDs. | No raw record body; care day distinct from upload time. |
| `get_history_through_day` | Source-linked, currently recorded context for a selected day and earlier populated days; optional date-range start and bounded sections with a continuation cursor. | Inclusive care-day cutoff; approved material only; never describe it as what was known at that time. |
| `get_approved_source_page` | A bounded text chunk from a specifically approved document page, with source hash and continuation offset. | The text is untrusted record content, not agent instructions; no raw binary or unreviewed page. |
| `get_latest_approved_update` | One approved update with version, review time and clearly labeled uncertainties. | No drafts; bounded length. |
| `list_my_tasks` | The connected adult's open tasks, reason, owner and due date. | A completed task is not clinical proof of treatment. |
| `search_approved_evidence` | A few bounded snippets with document/page, evidence category and citation URL. | Accepted evidence only; no raw PDFs or all-record dump by default. |

Proposed later write tools: `propose_question`, `propose_note`, `propose_update_draft`. They may create a draft or return a review link; they cannot approve or publish, invite members, change permissions, assign clinical urgency, send messages, or alter a source record. Avoid giant generic tools such as `query_database` or `get_all_records`. File upload stays in adeno's browser initially, so the model never needs an upload bearer URL or original binary in a tool response.

## Privacy boundary to resolve before hosted health-data access

MCP sends tool results to the selected AI client and potentially that client's model provider. An authorized caregiver must understand which client receives which data, including retention and training terms they choose with that provider. Tool annotations and client confirmation prompts do not replace adeno's own access checks.

The current managed-storage promise is ciphertext-only: adeno's hosted server cannot decrypt health records. A remote server that directly returns plaintext records would break that promise. A local/device companion could decrypt selected content with family-held keys, apply per-person permissions, and send only that approved content to a locally running AI client. This can work for suitable desktop/CLI clients, but cloud-hosted ChatGPT, Claude and Grok Bot connections cannot simply reach a caregiver's localhost. A secure tunnel or another explicit client-side sharing design would need separate validation and could still disclose the selected content to the AI host. There is no verified universal, one-click path for all web-only clients under the current E2EE promise. A hosted remote connector should initially expose only non-medical connection metadata until this is resolved. Any alternative involving server-readable health content requires an explicit revision of the privacy promise and a separate security review; do not silently adopt it.

For any content-sharing tool, require a visible data-access policy per client and person, allow revocation, record a minimal audit event, and return citations linking to adeno's authenticated viewer. Never put patient information in tool names, IDs, URLs, logs or OAuth grants. Documents are untrusted evidence, not tool instructions. The AI client is not authorized to diagnose, prescribe or publish a family update.

## Build sequence and gates

1. Ship a local, synthetic, read-only MCP proof of concept against approved sample records and tasks. Start with a desktop/CLI client that can reach a local companion; test cloud ChatGPT/Codex, Claude, Grok Bot and the confirmed Muse product separately after the disclosure path is designed. Show honest unsupported states.
2. Design per-adult family identity, consent, scopes, token revocation, server-side authorization and E2EE sharing together. Inbound MCP OAuth is separate from the existing outbound OpenRouter OAuth code. Use Streamable HTTP and OAuth discovery with audience-bound, short-lived tokens. Implement browser-based sign-in and family selection before any health-data tool.
3. Agree on the encryption and model-host disclosure boundary. Prototype a local companion with a desktop client, then separately verify whether a web-only client can access family-approved plaintext without making the adeno server a plaintext processor. Do not advertise parity between those paths. Keep the hosted managed-mode startup guard until this gate passes.
4. Propose the smallest additive schema for family memberships, approved update versions, task ownership, connection grants and audit. **Request explicit permission before creating or applying migrations.**
5. Reuse domain services behind a dedicated MCP adapter, then test cross-family denial, revoked memberships, scope downgrades, prompt-injection content, large outputs, citation resolution and no surprise writes. Do not reuse owner-only REST authorization as proof that family-scoped MCP access is safe.
6. Test the same short setup instruction across clients and publish precise help only for clients whose auth and tool flows have passed an end-to-end test. Keep record upload/review and a usable question workflow in the browser for anyone without a compatible AI account.

Outbound family messages, payments, calendar sync and broad disease research remain later work. They do not block a useful read-only MCP prototype, but they also do not relax hosted privacy and authorization gates.
