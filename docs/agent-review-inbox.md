# Adult review inbox for child contributions

Product design, 2026-09-24. **Not implemented.** This extends [day grants and snapshots](day-access-and-history.md). It does not authorize a database migration or a public MCP endpoint.

## Promise and limit

When a child submits a note, file, or correction, Adeno durably records a pending proposal and shows it in the appropriate adult's review inbox. A connected adult agent may learn that **a family contribution needs review**. The child contribution is not published, summarized by a model, or sent to an AI provider just because it was submitted.

MCP change notifications are an optional live hint for clients that maintain a supported subscription. They are not guaranteed delivery to a closed or unsupported AI client. The durable inbox, visible in the web app and fetched on the next agent interaction, is the source of truth. A guaranteed immediate alert when the adult is offline would require a separately approved channel such as email or device push; that is not part of the first slice.

## Event flow

1. The child submits through authenticated web intake. Adeno checks the child's active account and `contribute` grant for an existing day, or a narrow profile-level `submit_to_review` grant for a new or uncertain day. That grant cannot read other days or publish. Adeno saves the original/proposal, author, server timestamp, target day when known, and source links. The current published day snapshot does not change.
2. In the same transaction, Adeno creates one durable `review_requested` event keyed to the proposal and assigns it to eligible adult reviewers. An adult needs an active account and either a `publish` grant for an existing day or admin/review authority for a new or undated day. A revoked or disabled adult is not eligible. The admin may choose a primary adult reviewer; other eligible adults can still review if permitted.
3. The web app shows an authenticated **Needs adult review** badge and a queue item. On the agent side, `get_connection_profile` may return a pending count and `list_pending_reviews` returns opaque review IDs, creation time, and a generic status—no child name, care date, filename, note text, medical content, or patient identity by default. The agent can say, “A family contribution is waiting for your review,” and provide an authenticated review link. The link has no bearer token or medical content in its URL.
4. If the adult explicitly asks the agent for details, a separate `get_pending_review` read checks that adult's current grants, source permissions, and the agent's `reviews:content` scope. The UI must make clear that returning details to a cloud AI client discloses them to that client/provider. The first pilot can omit this tool and keep detailed review in the browser.
5. The adult approves or rejects in the web app. Approval creates exactly one new immutable day snapshot; rejection preserves the proposal and decision in an audit history but changes no published day. Any connected agent can re-fetch the queue and see the resolved status. A revoked reviewer immediately loses queue and detail access, including old event IDs.

The server stores per-review status independently of per-agent delivery/seen cursors. Repeated notifications or two agents viewing the same item must not duplicate a proposal or publish twice. A monotonically increasing cursor lets clients catch up after disconnects. Queue counts and pagination must be computed only from items the adult can currently review; they cannot reveal hidden days or another family's activity.

## MCP contract

- `list_pending_reviews(cursor?, limit?)`: read-only, bounded, authorized queue; generic metadata only. Query it when the adult opens their agent or asks what needs review.
- `get_pending_review(id)`: optional later, separately scoped content read with explicit disclosure. No raw original binary.
- `adeno://my/reviews` resource: if the client supports subscriptions, send a `resources/updated` change hint when its authorized queue changes. The client must fetch the queue; the notification carries no proposal content. No claim that every ChatGPT, Codex, Claude, or other client will surface the signal proactively.
- No MCP `approve`, `reject`, `publish`, or account-grant tool in the first family pilot. The adult reviews and acts in the authenticated browser.

The copied agent-setup instruction can add one sentence: “When I ask what needs attention, check my Adeno review inbox.” Do not instruct the agent to poll continuously, assume background execution, or contact the adult outside the chosen client.

## Fictional acceptance checks

- A child proposal creates one pending queue item for the intended adult and no published day revision.
- An eligible adult sees one generic event in web and MCP; an unrelated adult, revoked adult, or another family sees neither count nor event.
- The agent sees no child text or source bytes through the generic notification or queue list.
- Disconnect/reconnect or duplicate delivery leaves the proposal pending once; approval publishes once and removes it from pending lists.
- Revoking day publish access immediately removes the event and blocks direct review-ID access.
- Agent clients without subscriptions still discover the item on their next authorized queue read.

The current MCP TypeScript package has only in-memory read tools and no public authenticated transport. This design needs durable storage, account grants, and a separately approved additive migration before real family data is used.
