import sharp from "sharp";
import { randomBytes, createHash } from "node:crypto";
import { createParserSocketRenderer } from "./ingest/parserRenditionSocket.js";

// Generates all source pixels; accepts no document/file input.
const socketPath = process.env.ADENO_PARSER_SOCKET_PATH;
if (process.env.ADENO_SYNTHETIC_PROBE !== "1" || !socketPath) throw new Error("Synthetic rendition opt-in required");
try {
  const source = await sharp(randomBytes(800 * 600 * 3), { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer();
  const render = createParserSocketRenderer({ socketPath, trustedWorkerUid: 10002, timeoutMs: 15000 });
  const result = await render(source, "image/png");
  const invalid = await render(source.subarray(0, -8), "image/png");
  const bound = result.verdict === "safe" && result.sourceSha256 === createHash("sha256").update(source).digest("hex");
  const largeReply = result.verdict === "safe" && result.rendition.data.length > 2048;
  const deniedCorruption = invalid.verdict === "rejected";
  process.stdout.write(`${JSON.stringify({ probe: "generated-rendition-only", bound, largeReply, deniedCorruption })}\n`);
  if (!bound || !largeReply || !deniedCorruption) process.exitCode = 1;
} catch { process.stderr.write("Synthetic rendition probe failed\n"); process.exitCode = 1; }
