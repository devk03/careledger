import { isAbsolute } from "node:path";

import { createPublicShellApp } from "./publicShell.js";

const root = process.env.ADENO_SHELL_WEB_ROOT;
const port = Number(process.env.PORT ?? "8080");
if (process.env.ADENO_SHELL_MODE !== "public-only" || !root ||
  !isAbsolute(root) || !Number.isSafeInteger(port) || port < 1 ||
  port > 65535) {
  throw new Error("Public shell needs ADENO_SHELL_MODE=public-only, " +
    "an absolute ADENO_SHELL_WEB_ROOT and a valid PORT");
}

const app = createPublicShellApp(root);
const server = app.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Adeno public-only shell listening on ${port}\n`);
});
function shutdown(): void {
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
