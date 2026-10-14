import { createClamdScanner } from "./ingest/clamdScanner.js";

const socketPath = process.env.ADENO_SCANNER_SOCKET_PATH;
if (process.env.ADENO_SYNTHETIC_PROBE !== "1" || !socketPath)
  throw new Error("Synthetic unavailable-scanner probe requires explicit opt-in and a socket");
try {
  const scanner = createClamdScanner({ socketPath, trustedWorkerUid: 10004, timeoutMs: 5000 });
  const result = await scanner.scan(Buffer.from("Independently invented scanner-unavailable fixture."), "image/png");
  const unavailable = result.verdict === "unavailable";
  process.stdout.write(`${JSON.stringify({ probe: "synthetic-unavailable-scanner", unavailable })}\n`);
  if (!unavailable) process.exitCode = 1;
} catch { process.stderr.write("Synthetic scanner-unavailable probe failed\n"); process.exitCode = 1; }
