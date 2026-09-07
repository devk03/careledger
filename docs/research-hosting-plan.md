# Research, hosting, and API security plan

Status: proposed implementation plan, reviewed 2026-09-07. No hosted services or paid research calls were provisioned by this planning task. Current local testing uses the community edition; managed E2EE, research chat, shared family accounts, and paid inference are not yet integrated.

## Decisions

Confirmed by the maintainer on 2026-09-07: Railway is the initial deployment platform. Optimize OpenRouter usage for free or inexpensive models. Use free endpoints for fictional test data and public-literature experiments initially; select the least expensive model that passes the task-specific quality, privacy and availability checks for hosted medical explanations. This decision does not remove the hosted launch gates below.

### Low-cost model evaluation shortlist

Public OpenRouter catalog checked 2026-09-07 (discovery only, no paid inference):

| Candidate | Input / million tokens | Output / million tokens | Initial evaluation |
| --- | --- | --- | --- |
| `google/gemma-4-26b-a4b-it:free` | $0 | $0 | Fictional text/image examples |
| `nvidia/nemotron-3-super-120b-a12b:free` | $0 | $0 | Fictional text and public-source summaries |
| `qwen/qwen3.5-flash-02-23` | $0.065 | $0.26 | Inexpensive text/image candidate |
| `google/gemma-3-27b-it` | $0.08 | $0.45 | Alternative text/image candidate |

Listed prices are discovery prices, not guaranteed prices for an endpoint meeting the required privacy policy. Availability, modality, tool/structured-output support and endpoint policies must be verified before enablement. No candidate has yet passed Adeno's medical evaluation. Keep the current configured model unchanged until those evaluations pass.

At the listed Qwen rates, 10,000 input tokens plus 2,000 billed output tokens would cost $0.00117; 1,000 such requests would be $1.17 before search, image-accounting differences, additional reasoning tokens, retries, gateway credit fees and hosting. This is an arithmetic illustration, not a promised per-report price.

OpenRouter documents 50 free-model requests/day without purchasing at least $10 credits, or 1,000/day after doing so. Those shared account limits and variable availability make free endpoints unsuitable as the sole hosted capacity plan. Use a fixed allowlist, no automatic random free router for private records, no unannounced paid escalation, and no fallback that weakens privacy requirements. Let caregivers see a clear availability message if no approved endpoint fits the reserved budget.

Sources: [live model catalog](https://openrouter.ai/api/v1/models), [free-model limits](https://openrouter.ai/docs/faq), [ZDR endpoint policy](https://openrouter.ai/docs/guides/features/zdr).

Read-only provisioning check: Railway CLI is installed, but this checkout has no linked Railway project. The optional Stripe Projects catalog plugin was unavailable; no service was provisioned through it. No hosted deployment or funded inference was started during this decision update.

Product update, 2026-09-07: the name is Adeno and the primary launch is a hosted service for nontechnical caregivers. Managed signup, family permissions and operator-managed AI billing take priority. Self-hosting remains available from the same open-source codebase as an optional advanced path. The Docker pilot below is an implementation stepping stone; it must not become the default caregiver onboarding. Earlier caregiver-funded OAuth remains a technical fallback, not the primary product experience. Hosted billing must still meet the existing E2EE and credential-isolation requirements before launch.

- Keep one open-source codebase and the portable Docker installation.
- Start research with medical databases plus one configurable OpenRouter search engine. Do not pay for redundant search integrations on every question.
- Offer native OpenAI Responses web search as an alternative adapter, not a second automatic research pass.
- Add direct Exa or Perplexity only when a measured retrieval, auditability, or cost advantage justifies it.
- Use Railway with a persistent volume for the existing Docker pilot. Cloudflare can provide the domain/front door. Treat a full Cloudflare Workers deployment as a later storage/runtime adaptation.
- Keep all operator-owned provider and provisioning keys on the server. Preserve the existing encrypted-storage requirement; do not route private records through a server proxy while claiming the operator cannot read them.
- Keep GitHub Actions and deployment manual. No paid background research by default.

## Search comparison

| Option | What it adds | Initial decision |
| --- | --- | --- |
| OpenRouter search | Model-directed search, citations, engine selection, filters, and bounded tool use through the existing provider integration | Default prototype; select an explicit engine and test its limits |
| OpenAI Responses `web_search` | Search and answer in one API, citations, domain filtering, full source list and live-access controls | Supported alternative; no sandbox required |
| Direct Exa | Independent retrieval pipeline with page text/highlights and refresh controls; content can be inspected before model synthesis | Add if we need more retrieval control than the gateway exposes |
| Direct Perplexity Search | Raw ranked results, regional/language/domain filters, multi-query requests, independently budgeted retrieval | Candidate if batched queries reduce measured cost or improve coverage |
| Perplexity Sonar/Agent research | Provider-managed search and synthesis | Optional comparison; not proof of superior medical evidence |
| PubMed and trial registries | Stable paper/trial identifiers and structured medical evidence | Core adapters alongside web search |

No provider-quality benchmark has been run. More sources or an additional search vendor do not establish higher clinical accuracy. Discovery must be followed by evidence verification, with abstract-only access clearly marked.

Pricing checked in fetched official pages: OpenRouter Exa Instant/Fast/Auto is $0.007/search (up to ten results), deeper modes $0.012–$0.015; Perplexity engine is $0.005/search. Both add model costs. This corrects an earlier conversation estimate of $0.005 for Exa. Direct Exa lists $7/1,000 basic searches. Direct Perplexity Search lists $5/1,000 successful requests and supports up to five queries per billed request. These are retrieval prices, not complete report prices; gateway batching equivalence is unverified.

References: [OpenRouter search](https://openrouter.ai/docs/guides/features/server-tools/web-search), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Exa pricing](https://exa.ai/pricing), [Exa contents](https://exa.ai/docs/reference/contents-retrieval), [Perplexity Search](https://docs.perplexity.ai/docs/search/quickstart), [Perplexity pricing](https://docs.perplexity.ai/docs/getting-started/pricing).

## Research implementation

1. Create an editable research brief in the browser from approved facts and the caregiver's question. Preserve unknowns. Public search gets minimal disease terms, not uploads, names, identifiers, or the private chat history. Even disease terms can disclose sensitive interests; show the external recipients.
2. Search PubMed and trial registries, then use explicit web-search tools to fill gaps. Include country and site-level trial availability where requested; do not assume US approval or access applies elsewhere.
3. Normalize sources into a bounded record: DOI/PMID/NCT or source URL, title, publication/update date, retrieval date, content access level, study type, and retrieved excerpts. Deduplicate trials and papers; preserve conflicting findings and failed searches.
4. Produce a cited dossier: what was found, relevance, limitations, current established options versus experimental evidence, and questions for clinicians. Validate identifiers and citation targets against actual retrieval results. Trial eligibility remains unresolved until the study team assesses it.
5. Save private annotations and case-specific dossiers encrypted. Public literature caches may be shared subject to source terms; private queries, case matching, and private reports must never enter a shared cache.
6. Add opt-in refresh later. Show search scope and last-checked dates; never claim exhaustive internet coverage. A provider outage returns a partial report, not an invented conclusion.

Evaluation before choosing a default: use 20 wholly fictional research cases including uncertain diagnoses, missing biomarkers, rare disease, contradictory studies, stale trial listings, and different treatment countries. Compare the gateway baseline, native OpenAI search, and only then a direct retrieval adapter. Measure source validity, citation support, relevant-study/trial coverage, limitations captured, latency, and total billed cost. Qualified clinical review is required for the medical quality assessment. Live paid evaluation requires a funded account and an explicit small batch budget.

## API keys and medical privacy

These are different secrets: operator provider keys, caregiver provider credentials, and household vault keys.

- Operator provider keys belong in runtime secrets, never React/Vite variables, JavaScript bundles, source maps, browser storage, HTML, API responses, Git, Docker build arguments, or model prompts. Keep provisioning credentials separate from inference credentials and use separate development/staging/production accounts or projects.
- A hosted public-research endpoint can use the operator's key server-side while receiving only an approved minimal research query. Search and AI providers still see what we send them.
- A hosted endpoint that receives decrypted medical records necessarily exposes that plaintext to its runtime. TLS, `store:false`, and no-log settings do not turn this into end-to-end encrypted inference.
- For private record analysis under the existing E2EE requirement, retain direct browser-to-provider processing after consent. A caregiver-owned OAuth credential is accessible to that caregiver's browser; it must never be an operator-wide key.
- Unified hosted billing with direct private inference needs a provider-supported delegated credential with independently enforceable budget, revocation, model/tool restrictions and bounded lifetime, or a separately verified confidential-inference design. This capability is not established in the current implementation. A scoped credential is visible to its recipient; do not describe it as hidden. Keep this launch gate explicit rather than silently weakening E2EE.
- The older `e2ee-managed.md` describes caregiver-funded OAuth and separate hosting charges. Unified hosted billing is the new product target, but that earlier private-data boundary remains binding until a concrete replacement is verified and accepted.

## Server enforcement before paid access

1. Require authenticated sessions, household membership, permissions, CSRF/origin checks, and authorized object scope on every paid operation. Never trust browser-supplied balances, household IDs, arbitrary provider URLs, or unrestricted request bodies. CORS is not authentication.
2. Reserve the worst-case allowed charge transactionally before dispatch; cap concurrent runs, searches, fetched pages, total context, model output/reasoning, retries and duration. Reconcile actual provider usage; retain reservations for ambiguous failures until reconciled. Idempotency must prevent duplicate billing and duplicate dispatch after retries/webhooks.
3. Enforce prepaid balance, per-user/household limits, provider limits and a global daily circuit breaker. Infrastructure budgets need a separate cap/alert. Cancellation and HTTP timeout do not guarantee the provider stops charging.
4. Pin engine and model allowlists. OpenRouter documents `max_uses` for its hosted search engines, but most native engines ignore that parameter; use only tested provider limits or application-executed search calls for a strict budget. A result-count cap alone is insufficient.
5. Validate outbound HTTPS hosts, redirects, DNS resolutions, byte limits and timeouts. Block private/loopback/link-local/metadata addresses on any fetch service. Attach provider Authorization headers only to the fixed provider host, never to retrieved webpages.
6. Treat source pages and model outputs as untrusted data. They cannot choose credentials, alter permissions, execute code, make purchases, change treatment records, or contact trial teams. Render safe text and validated links with a restrictive CSP.
7. Keep prompts, documents, bearer tokens and provider response bodies out of routine logs/error telemetry. Log opaque request IDs, aggregate usage, status and safe error codes. Redact at the application, proxy and monitoring layers; disable sensitive AI-gateway request logging.
8. Replace the current first-run bearer URL in application logs before hosted launch. Use an operator-only setup channel, with expiry and one-time use. Preserve a usable local setup procedure.
9. Scan tracked files/history, production bundles, source maps and image layers for secrets before publication; exercise injected fake credentials in error/log tests. Rotate any exposed real credential and invalidate dependent sessions. `.gitignore` alone does not remove already tracked secrets.

Cloudflare has runtime secret bindings and CLI secret installation; use secrets rather than plaintext Wrangler variables. [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Hosting choice

Cloudflare CLI deployment is supported with Wrangler. The issue is compatibility, not CLI availability. Current Adeno relies on SQLite, originals, local generated secrets, backups, native Python packages, and in-process background workers. Cloudflare Containers explicitly has ephemeral disk, including after platform restarts; an unchanged container would not preserve `/data` reliably. Python Workers supports FastAPI, but storage, package support and job execution still need adaptation.

Recommended first pilot: one Railway Docker service, one durable `/data` volume, one replica, readiness check, HTTPS and backups. Its Hobby plan has a $5 monthly floor including $5 usage; actual resource consumption can exceed this. Use a provisional $15/month pilot infrastructure allowance, measured and revised before launch, rather than promising a fixed bill. Cloudflare DNS/TLS is optional; avoid extra proxy layers until their benefit is demonstrated. A shared public deployment is blocked by the current one-household database design and unfinished managed mode.

If full Cloudflare hosting is preferred later: deploy React assets and API/auth to Workers, encrypted blobs to R2, account/billing metadata and sync state to D1/Durable Objects, and resumable jobs to Queues/Workflows. Port the storage APIs and transaction semantics, replace filesystem processing, and prove restore/recovery. D1 is not a drop-in mount for the current SQLite file. Do not mount R2 as a substitute for a transactional local database.

CLI paths after configuration: `railway up` for the Docker pilot; `npx wrangler deploy` for a future Workers application. Neither command has been run by this task. Keep a reviewed release manifest, scoped runtime secrets, a rollback image, migration preflight/backup, and manual publication.

References: [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/), [Containers persistence](https://developers.cloudflare.com/containers/faq/), [Python Workers FastAPI](https://developers.cloudflare.com/workers/languages/python/packages/fastapi/), [Railway CLI](https://docs.railway.com/cli), [Railway volumes](https://docs.railway.com/volumes), [Railway pricing](https://docs.railway.com/pricing/plans).

## Delivery sequence and acceptance

1. Local review: rebuild current Docker app, bind loopback, verify readiness and setup, and preserve the existing volume. AI stays unavailable until configured. This is community-mode UI testing, not a managed-encryption demonstration.
2. Credential boundary: implement safe setup delivery, redaction, fixed-host provider adapters, session/permission enforcement and fake-secret leakage tests. Confirm production assets contain no operator credentials.
3. Research slice: deliver one medical-registry adapter, one web-search adapter, cited report UI and saved reports. Test provider failures, fabricated references, prompt injection and partial evidence with fictional fixtures.
4. Cost recovery: implement prepaid ledger and atomic reservations, exact usage reconciliation and global shutdown. Review database migration SQL before applying any new billing or multi-household schema; the earlier v5 approval does not authorize new migrations. Include payment processing, hosting, storage and search costs in the transparent cost formula.
5. Private hosted readiness: integrate ciphertext-only storage, device enrollment, recovery, revocation, sharing and deletion; verify the private AI/billing path above. Test cross-household denial, ciphertext tampering, lost-device recovery and restored backups. Current cryptographic primitives and schema are insufficient alone.
6. Synthetic hosted staging: deploy manually to the chosen platform after credentials and a spending limit are set. Verify the TLS boundary, volume durability across redeploy, backup restoration, authenticated API access, CSP, denied cross-origin requests, quota races and log redaction. User approval remains required for publication and migrations.
7. Launch: resolve external security findings and clinical evaluation failures, show accurate privacy/cost disclosures, and enable real family onboarding only after the gates pass.

No sandbox computer is required for search/reading/synthesis. Document parsing still needs its own isolation and resource limits: existing parser checks are not a malware scanner, and a Worker thread is not a full security sandbox.
