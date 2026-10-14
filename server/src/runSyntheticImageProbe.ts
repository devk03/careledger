import sharp from "sharp";
import { createParserSocketInspector } from "./ingest/parserSocket.js";

// Generates its own bytes; accepts no document, filesystem or network input.
const socketPath = process.env.ADENO_PARSER_SOCKET_PATH;
if (process.env.ADENO_SYNTHETIC_PROBE !== "1" || !socketPath)
  throw new Error("Synthetic image probe requires explicit opt-in and a parser socket");
const inspector = createParserSocketInspector({ socketPath, trustedWorkerUid: 10002,
  timeoutMs: 15_000, maxConcurrentInspections: 1 });
try {
  const png = await sharp({ create: { width: 2, height: 3, channels: 3,
    background: { r: 17, g: 43, b: 79 } } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 2, height: 3, channels: 3,
    background: { r: 79, g: 43, b: 17 } } }).jpeg().toBuffer();
  const pngResult = await inspector.inspect(png, "image/png");
  const jpegResult = await inspector.inspect(jpeg, "image/jpeg");
  const truncated = await inspector.inspect(png.subarray(0, png.length - 8), "image/png");
  const closedPdf = await inspector.inspect(Buffer.from("%PDF-1.7\nINVENTED PROBE ONLY\n%%EOF"), "application/pdf");
  const result = { probe: "generated-images-only",
    pngAccepted: pngResult.status === "safe" && pngResult.pageCount === 1,
    jpegAccepted: jpegResult.status === "safe" && jpegResult.pageCount === 1,
    truncatedRejected: truncated.status === "rejected", pdfRejected: closedPdf.status === "rejected" };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.pngAccepted || !result.jpegAccepted || !result.truncatedRejected || !result.pdfRejected)
    process.exitCode = 1;
} catch {
  process.stdout.write(`${JSON.stringify({ probe: "generated-images-only", failed: true })}\n`);
  process.exitCode = 1;
}
