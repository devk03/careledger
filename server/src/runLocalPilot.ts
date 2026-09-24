import { isAbsolute } from "node:path";

import { cookieAuthenticator } from "./auth/cookieSession.js";
import { SqliteFamilyAccounts } from "./auth/familyAccounts.js";
import { createHttpApp } from "./http/app.js";
import { SqliteFamilyMutations } from "./storage/sqliteFamilyMutations.js";
import { SqliteFamilyTimeline } from "./storage/sqliteFamilyTimeline.js";

/**
 * Explicitly local, opt-in v7 API runner. It never initializes or migrates a DB,
 * and it does not replace the currently deployed Python service.
 */
const path = process.env.ADENO_PILOT_DB_PATH;
const origin = process.env.ADENO_PILOT_ORIGIN;
const portText = process.env.ADENO_PILOT_PORT ?? "8090";
const port = Number(portText);
if (!path || !isAbsolute(path) || !origin || !/^https?:\/\/[^/]+$/.test(origin) ||
  !Number.isInteger(port) || port < 1024 || port > 65535 ||
  process.env.ADENO_PILOT_LOCAL_ONLY !== "1") {
  throw new Error("Local pilot requires ADENO_PILOT_LOCAL_ONLY=1, an absolute " +
    "ADENO_PILOT_DB_PATH, exact ADENO_PILOT_ORIGIN, and a valid high port");
}

const timeline = new SqliteFamilyTimeline(path);
let mutations: SqliteFamilyMutations;
let accounts: SqliteFamilyAccounts;
try {
  mutations = new SqliteFamilyMutations(path);
  accounts = new SqliteFamilyAccounts(path);
} catch (error) {
  timeline.close();
  throw error;
}

const app = createHttpApp({
  authenticate: cookieAuthenticator(timeline), timeline, pages: timeline,
  profiles: timeline, reviews: timeline, versions: timeline, sessions: timeline,
  mutations, accounts, expectedOrigin: origin, readiness: () => timeline.ready(),
});
const server = app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Adeno TypeScript local pilot API listening on 127.0.0.1:${port}\n`);
});
function shutdown(): void {
  server.close(() => {
    accounts.close(); mutations.close(); timeline.close();
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
