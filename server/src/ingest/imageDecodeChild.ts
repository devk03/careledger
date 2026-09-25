import { createHash } from "node:crypto";
import sharp from "sharp";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import { decodeImageInWorker } from "./imageDecoder.js";

/** One input, one fixed JSON result, then exit. No filenames or record text. */
async function main(): Promise<void> {
  sharp.concurrency(1);
  sharp.cache(false);
  const [mediaType, expectedSha256] = process.argv.slice(2);
  if ((mediaType !== "image/jpeg" && mediaType !== "image/png") ||
    !expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_UPLOAD_BYTES) throw new Error();
    chunks.push(bytes);
  }
  if (total < 1) throw new Error();
  const input = Buffer.concat(chunks, total);
  if (createHash("sha256").update(input).digest("hex") !== expectedSha256)
    throw new Error();
  const result = await decodeImageInWorker(input, mediaType);
  process.stdout.write(JSON.stringify(result));
}

try { await main(); }
catch { process.exitCode = 1; }
