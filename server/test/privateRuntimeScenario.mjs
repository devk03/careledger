// Run via node --input-type=module on stdin inside an isolated synthetic runtime.
// This is not human acceptance, TLS verification or actual AI-client evidence.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

assert.equal(readFileSync("/data/SYNTHETIC_ONLY", "utf8").startsWith("Independently invented"), true);
const mode = process.env.ADENO_SYNTHETIC_SCENARIO;
assert.ok(["setup", "restart", "disconnect", "logout"].includes(mode));
const file = "/data/synthetic-acceptance-state.json";
const origin = "https://adeno.kunjadia.dev";
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch("http://127.0.0.1:8080/api/v2/auth/setup-status", { signal: AbortSignal.timeout(1000) });
    if (response.ok) { ready = true; break; }
  } catch { /* Bounded startup readiness, no mutation retries. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(ready, true, "Synthetic app did not become ready within the bounded startup check");
let state = mode === "setup" ? { password: randomBytes(24).toString("base64url") } : JSON.parse(readFileSync(file, "utf8"));
const persist = () => writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
if (mode === "setup") writeFileSync(file, JSON.stringify(state), { flag: "wx", mode: 0o600 });
async function request(path, { method = "GET", body, status = 200, authenticated = true, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:8080/api/v2${path}`, {
    method, signal: AbortSignal.timeout(40_000), headers: { origin,
      ...(authenticated && state.cookie ? { cookie: state.cookie } : {}),
      ...(method === "POST" && state.csrf ? { "x-csrf-token": state.csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  });
  assert.equal(response.status, status, `Unexpected status for ${path}: ${response.status}`);
  if (response.headers.get("set-cookie")) state.cookie = response.headers.get("set-cookie").split(";")[0];
  if (status === 204) return undefined;
  if (response.headers.get("content-type")?.startsWith("image/")) return Buffer.from(await response.arrayBuffer());
  return response.json();
}
const post = (path, body, status = 200) => request(path, { method: "POST", body, status });
if (mode === "setup") {
  await request("/auth/session", { status: 401, authenticated: false });
  await post("/auth/invitations", {}, 404);
  await post("/auth/signup", {}, 404);
  await post("/auth/setup", { token: readFileSync("/data/secrets/bootstrap-token", "utf8").trim(),
    displayName: "Invented acceptance owner", householdName: "Invented acceptance household", password: state.password }, 201);
  state.csrf = (await request("/auth/session")).csrfToken;
  persist();
  const { profile } = await post("/care-profiles", { preferredName: "Invented acceptance person" }, 201);
  state.profileId = profile.id;
  persist();
  const base = `/care-profiles/${profile.id}`;
  const bytes = await sharp({ create: { width: 240, height: 160, channels: 3, background: "white" } }).png().toBuffer();
  state.originalHash = createHash("sha256").update(bytes).digest("hex");
  const uploaded = await request(`${base}/documents`, { method: "POST", body: bytes, status: 201,
    headers: { "content-type": "image/png", "x-upload-name": "independently-invented.png" } });
  state.documentId = uploaded.documentId;
  persist();
  assert.equal((await request(`${base}/timeline/history?through=2030-04-12`)).days.length, 0);
  const proposal = await post(`${base}/documents/${state.documentId}/day-proposals`, { careDay: "2030-04-12" }, 201);
  assert.equal((await request(`${base}/timeline/history?through=2030-04-12`)).days.length, 0);
  const detail = await request(`${base}/reviews/document-days/${proposal.revisionId}`);
  await post(`${base}/timeline/document-days/${proposal.revisionId}/review`, { decision: "accepted", expectedDayRevision: detail.expectedDayRevision });
  const note = await post(`${base}/timeline/days/2030-04-12/notes`, { body: "Independently invented family observation for acceptance." }, 201);
  const { note: pending } = await request(`${base}/reviews/notes/${note.revisionId}`);
  await post(`${base}/timeline/notes/${note.revisionId}/review`, { decision: "accepted", expectedDayRevision: pending.expectedDayRevision });
  const grant = await post("/agent-connections", { consent: "approved_history_and_sources_v1" }, 201);
  state.grantId = grant.grantId;
} else if (mode === "restart") {
  // Confirm the previously issued session survives the process restart, then log in afresh.
  await request("/auth/session");
  await post("/auth/login", { loginName: "owner", password: state.password });
  state.csrf = (await request("/auth/session")).csrfToken;
} else if (mode === "disconnect") {
  await post(`/agent-connections/${state.grantId}/disconnect`, {}, 204);
} else {
  await post("/auth/logout", {}, 204);
  await request("/auth/session", { status: 401 });
  console.log(JSON.stringify({ synthetic: true, mode, sessionDenied: true }));
  process.exit(0);
}
const base = `/care-profiles/${state.profileId}`;
const history = await request(`${base}/timeline/history?through=2030-04-12`);
assert.equal(history.days.length, 1);
assert.equal(history.days[0].revision, 2);
assert.equal(history.days[0].statements[0].text, "Independently invented family observation for acceptance.");
assert.equal(history.days[0].sources[0].sourceSha256, state.originalHash);
assert.equal(history.days[0].sources[0].mediaType, "image/png");
const image = await request(`${base}/documents/${state.documentId}/original-image?expectedSha256=${state.originalHash}`);
assert.equal(createHash("sha256").update(image).digest("hex"), state.originalHash);
persist();
console.log(JSON.stringify({ synthetic: true, mode, approvedDays: 1, revision: 2, originalVerified: true,
  profileId: state.profileId, documentId: state.documentId, grantId: state.grantId }));
