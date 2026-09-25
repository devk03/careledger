import { isAbsolute } from "node:path";

import { startParserWorkerServer } from "./ingest/parserWorker.js";
import { archiveStaleParserSocket } from "./ingest/parserSocketRecovery.js";

/** Dedicated parser-process entrypoint. Launch under the image's lifetime
 * flock wrapper; direct concurrent starts against one socket are unsupported.
 * This process never opens a database or network port. */
const socketPath = process.env.ADENO_PARSER_SOCKET_PATH;
if (!socketPath || !isAbsolute(socketPath))
  throw new Error("ADENO_PARSER_SOCKET_PATH must be an absolute Unix socket path");
const timeoutMs = Number(process.env.ADENO_PARSER_TIMEOUT_MS ?? "30000");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
  throw new Error("Invalid ADENO_PARSER_TIMEOUT_MS");
await archiveStaleParserSocket(socketPath);
const server = await startParserWorkerServer({ socketPath, timeoutMs,
  maxConcurrentRequests: 1 });
function shutdown(): void {
  server.close(() => { process.exitCode = 0; });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
