import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import express from "express";

import { BootstrapTokenStore } from "./auth/bootstrapTokenStore.js";
import { cookieAuthenticator } from "./auth/cookieSession.js";
import { SqliteFamilyAccounts } from "./auth/familyAccounts.js";
import { createHttpApp } from "./http/app.js";
import { privatePilotHeaders } from "./http/privatePilotHeaders.js";
import { createPrivateAgentRouter } from "./http/privateAgentRouter.js";
import { PrivateAgentGrantStore } from "./auth/privateAgentGrants.js";
import { provisionPrivateDirectory } from "./ingest/privateDirectory.js";
import { privatePilotConfig } from "./privatePilotConfig.js";
import { SqliteFamilyMutations } from "./storage/sqliteFamilyMutations.js";
import { SqliteFamilyTimeline } from "./storage/sqliteFamilyTimeline.js";
import { createDocumentDayRouter } from "./http/documentDayRouter.js";
import { createOriginalImageRouter } from "./http/originalImageRouter.js";
import { createTrustedIntakeRouter } from "./http/trustedIntakeRouter.js";
import { createTrustedIntake } from "./ingest/trustedIntake.js";
import { createPrivateIntakeCapacity } from "./ingest/privateIntakeCapacity.js";
import { createClamdScanner } from "./ingest/clamdScanner.js";
import { createParserSocketInspector } from "./ingest/parserSocket.js";

// No schema initialization or migration is performed by this entrypoint.
process.umask(0o077);
const config = privatePilotConfig(process.env);
const webInfo = lstatSync(join(config.webRoot, "index.html"));
if (!webInfo.isFile() || webInfo.isSymbolicLink()) throw new Error("Private web build unavailable");
const timeline = new SqliteFamilyTimeline(config.databasePath);
const mutations = new SqliteFamilyMutations(config.databasePath);
const accounts = new SqliteFamilyAccounts(config.databasePath);
const bootstrap = new BootstrapTokenStore(config.secretsDirectory);
const pepperPath = join(config.secretsDirectory, "recovery-pepper");
let recoveryPepper: Buffer;
try {
  const info = lstatSync(pepperPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size !== 32)
    throw new Error("Private recovery configuration unavailable");
  recoveryPepper = readFileSync(pepperPath);
} catch (error) {
  if (accounts.isSetupComplete() || typeof error !== "object" || error === null ||
    !("code" in error) || error.code !== "ENOENT") throw error;
  recoveryPepper = randomBytes(32);
  writeFileSync(pepperPath, recoveryPepper, { flag: "wx", mode: 0o600 });
}
if (!accounts.isSetupComplete()) bootstrap.initialize();
const app = express();
app.disable("x-powered-by");
app.use(privatePilotHeaders);
app.get("/api/public/runtime", (_request, response) => {
  response.json({ mode: "trusted_private", restricted_preview: false,
    record_uploads_enabled: config.records !== null, managed_e2ee_enabled: false });
});
const agentGrants = config.agentConnectionsAvailable ? new PrivateAgentGrantStore(
  await provisionPrivateDirectory(config.secretsDirectory, "agent-grants")) : null;
const authenticate = cookieAuthenticator(timeline);
if (config.records) {
  const records = config.records;
  await provisionPrivateDirectory(dirname(config.databasePath), "objects");
  await provisionPrivateDirectory(dirname(config.databasePath), "quarantine");
  const upload = createTrustedIntake({ repository: mutations,
    scanner: createClamdScanner({ socketPath: records.scannerSocket, trustedWorkerUid: 10004, maxConcurrentScans: 1 }),
    parser: createParserSocketInspector({ socketPath: records.parserSocket, trustedWorkerUid: 10002, maxConcurrentInspections: 1 }),
    objectRoot: records.objectRoot, quarantineRoot: records.quarantineRoot,
    storageAvailable: createPrivateIntakeCapacity({ roots: [records.objectRoot, records.quarantineRoot],
      maxBytes: records.maxStorageBytes, minimumFreeBytes: 512 * 1024 * 1024 }) });
  app.use(createTrustedIntakeRouter({ expectedOrigin: config.origin, repository: mutations, upload }));
  app.use(createDocumentDayRouter({ expectedOrigin: config.origin, writer: mutations,
    reviews: { authenticate, repository: timeline }, inbox: { authenticate, repository: timeline } }));
  app.use(createOriginalImageRouter({ authenticate, repository: timeline, objectRoot: records.objectRoot }));
}
app.use(createHttpApp({ authenticate, timeline, pages: timeline,
  profiles: timeline, reviews: timeline, noteReviews: timeline, versions: timeline,
  sessions: timeline, mutations, profileWriter: mutations, accounts, expectedOrigin: config.origin,
  ownerSetup: { bootstrap, recoveryPepper }, allowInvitations: false,
  agentConnectionsAvailable: agentGrants !== null,
  intakeAvailable: config.records !== null, documentWorkflowAvailable: config.records !== null,
  readiness: () => timeline.ready() }));
if (agentGrants) app.use(createPrivateAgentRouter({ expectedOrigin: config.origin,
  authority: mutations, grants: agentGrants, inventory: { grants: agentGrants, sessions: timeline } }));
app.use(express.static(config.webRoot, { index: false, dotfiles: "deny", redirect: false }));
app.get("/", (_request, response) => { response.redirect(302, "/pilot"); });
app.get(["/pilot", "/pilot/privacy"], (_request, response) => {
  response.sendFile(join(config.webRoot, "index.html"));
});
app.use((_request, response) => { response.status(404).json({ error: "NOT_FOUND" }); });
app.use((_error: unknown, _request: express.Request, response: express.Response,
  _next: express.NextFunction) => {
  // No request bodies, source text, credentials or SQL errors reach logs/clients.
  response.status(500).json({ error: "REQUEST_FAILED" });
});
const server = app.listen(config.port, "0.0.0.0", () => {
  process.stderr.write("adeno trusted private runtime started; public signup disabled\n");
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  server.close(() => {
    accounts.close(); mutations.close(); timeline.close(); clearTimeout(deadline);
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
