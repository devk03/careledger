import sharp from "sharp";
import { createClamdScanner } from "./ingest/clamdScanner.js";

// Accepts no document input. EICAR is an inert standard antivirus test string.
const socketPath = process.env.ADENO_SCANNER_SOCKET_PATH;
if (process.env.ADENO_SYNTHETIC_PROBE !== "1" || !socketPath)
  throw new Error("Synthetic scanner probe requires explicit opt-in and a socket");
const scanner = createClamdScanner({ socketPath, trustedWorkerUid: 10004,
  timeoutMs: 30_000, maxConcurrentScans: 1 });
try {
  const png = await sharp({ create: { width: 2, height: 3, channels: 3,
    background: { r: 19, g: 41, b: 73 } } }).png().toBuffer();
  const inertTest = Buffer.from(["X5O!P%@AP[4", "\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""), "ascii");
  const clean = await scanner.scan(png, "image/png");
  const detected = await scanner.scan(inertTest, "image/png");
  const result = { probe: "generated-scanner-fixtures-only",
    generatedImageClean: clean.verdict === "clean", inertTestDetected: detected.verdict === "detected" };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.generatedImageClean || !result.inertTestDetected) process.exitCode = 1;
} catch {
  process.stdout.write(`${JSON.stringify({ probe: "generated-scanner-fixtures-only", failed: true })}\n`);
  process.exitCode = 1;
}
