# Caregiver communications: proposed rollout

Status: deferred backlog, outside the current core-platform increment. Approved family updates will be read inside the portal first; see [core platform](core-platform.md). No messaging accounts, outbound delivery, credentials, new database schema, or migrations have been provisioned. Research checked 2026-09-07. Audience: adult caregivers; messaging is optional, not clinical monitoring.

## Recommendation

Start with an in-app activity inbox and an opt-in email digest. Offer Web Push later for people who prefer it. Evaluate direct Meta WhatsApp Cloud API for a limited, opt-in notification pilot only after product eligibility, privacy and pricing review. Keep questions, explanations and documents inside authenticated Adeno rather than building a WhatsApp AI chatbot.

This is an engineering recommendation, not a claim that email is always cheaper: select a provider after modeling actual recipient volume, deliverability, retention and required agreements. Neither email nor Web Push is an end-to-end privacy boundary for record content. Push requires permission and an active service worker; protect its subscription endpoint as a secret. See [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) and [permission best practices](https://developer.mozilla.org/en-US/docs/Web/API/Push_API/Best_Practices).

## WhatsApp constraints and cost

- Recipients must provide their number and opt in; opt-outs must be honored. Business-initiated messages need approved templates; non-template replies are limited to the customer-service window. Health-information use also has regulatory restrictions. See [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/).
- Do not assume an AI chatbot is eligible: the [Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) restrict AI-primary functionality, with geography-dependent exceptions. Review Adeno's intended use before activation; a notification-only design is a proposal, not guaranteed approval.
- Meta rates vary by recipient market and message category. The [official pricing overview](https://whatsappbusiness.com/products/platform-pricing/) describes per-delivered-message pricing and certain free service/reply cases. The detailed developer rate-card page could not be retrieved during this review; resolve exact current and upcoming rates before budgeting. Do not design around permanent free allowances.
- [Twilio's published WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing) adds $0.005 per inbound or outbound message to applicable Meta template fees. Example: 1,000 families × 4 outbound reminders/month = $20/month in Twilio message fees alone, before Meta fees, replies, failed-message fees and any other costs. This is an illustration, not a quotation for launch. Direct Cloud API avoids that intermediary charge but adds integration/operations work.

## Phase 1: private, opt-in reminders

1. Finish hosted identity and family membership enforcement first. One person's admin status must not opt other adults into external messages. Authenticate and authorize every event and destination against current family membership.
2. Add individual, verified channel destinations; record channel/purpose consent, time zone, quiet hours, digest frequency and opt-out. Require recent authentication to change a destination. Recheck membership and consent immediately before sending, not just when queued.
3. Notify only from human-confirmed tasks, due dates and reviewable updates. Never infer clinical urgency or schedule medication reminders from unreviewed AI output.
4. Default message: “There’s an update in Adeno. Sign in to view it.” No patient names, diagnosis, treatment, clinician names, record titles, attachments, free-text excerpts, or health details in subject lines, push payloads or URLs. Even app identity and timing reveal metadata; disclose this residual risk.
5. Link to a generic HTTPS sign-in destination, not a bearer access link. Require login and current authorization to open an item. No tracking pixels or third-party link tracking. Outbound reminders cannot guarantee that an appointment or clinical need is attended to.
6. Include a simple channel opt-out; an unsubscribe token may revoke notifications only and must never grant record access. Treat arbitrary inbound WhatsApp messages/attachments as potentially sensitive; do not ingest them into records or AI. Document minimal retention and an automated generic redirect plus an app-support escalation path.

## Delivery and strict spending design

Proposed flow: confirmed task → transactional outbox → consent/membership check → cost reservation → channel adapter → provider → verified receipt → reconciliation.

- Use deterministic event/destination/template idempotency keys, row leases and bounded retries. If delivery is ambiguous, reconcile before retrying; do not release its cost reservation prematurely.
- Reserve a conservative cost before dispatch, including provider fees, currency conversion buffer, taxes where applicable, and retries. Unknown rates or insufficient global/family funds block sending. Define a maximum monthly and daily notification budget independent of inference usage.
- Funding pool: cleared contributions minus processor fees, refund/chargeback reserve, hosting commitments, already-spent and reserved AI/message costs, and safety runway. Do not spend promised donations or raise allowances automatically from gross receipts. Only an audited policy change based on settled surplus raises family limits.
- Serialize reservations atomically so concurrent workers cannot overspend. Count inbound-provider costs too; per-family outbound limits alone cannot bound an uncapped paid inbound channel. Before activating WhatsApp, validate provider/account controls for inbound abuse. If no credible hard bound exists, leave that channel disabled.
- Configure provider spend ceilings where supported, verify rate-card freshness, reconcile actual invoices and delivery receipts, monitor drift, and provide a global kill switch. Caps should degrade to in-app notices, never silently erase a family task.
- Keep provider keys server-side in deployment secrets, with least privilege and rotation. Use fixed adapter endpoints, egress restrictions, signed webhook verification, replay protection, input size limits and rate limiting. Never log bodies, medical content, destination values, tokens or secrets.
- Record minimal delivery status (queued/sent/delivered/failed); delivered is not read or acted on. Redact operator dashboards. Audit permission changes and spending overrides without patient content.
- E2EE target: schedule generic reminders from minimal client-approved metadata. Do not give a background worker decryption keys or decrypt records merely to compose messages. Make schedule metadata leakage explicit in the future threat model.

## Implementation sequence and acceptance gates

1. Review hosted auth and notification threat model; choose initial audience jurisdictions and approximate monthly volume. No external provider activation yet.
2. Implement settings and inbox UI with wholly fictional test data; no reminder controls pretending to be live.
3. Propose schema for destinations/consents, outbox, delivery receipts and cost reservations. **Request explicit approval before creating or applying migrations.** Reuse existing financial ledger concepts where suitable; do not assume hosted metering is complete.
4. Implement a fake adapter and deterministic tests: no consent, revoked membership, quiet hours/DST, duplicates, expired leases, concurrent spending, unknown prices, provider timeout, invalid/replayed webhook, unsubscribe, global pause, no sensitive payloads, and inaccessible cross-family links.
5. Add one email adapter behind a disabled feature flag. Verify credentials and synthetic delivery in an authorized test account; assess deliverability, rate limits and bill reconciliation before opt-in beta.
6. Consider optional Web Push. Pilot WhatsApp only if audience demand warrants its incremental cost and all policy/privacy/budget gates pass. No WhatsApp document dump or general treatment-answering bot in this phase.

Public repository: adapter interfaces, policy logic, consent UI, fake integrations and tests. Private operations: real destination lists, provider keys, account IDs, production thresholds and audit dashboards. Closed-source tools are not an access-control mechanism; secure every privileged operation on the server.
