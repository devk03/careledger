import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAuthorizedTimelineMcpServer } from "../../dist/mcp/authorizedTimeline.js";
import { renderImageInSubprocess } from "../../dist/ingest/imageDecodeProcess.js";

// Wire-protocol fixture only: creates its own pixels, accepts no document input.
if (process.env.ADENO_FICTIONAL_STDIO_TEST !== "1") process.exit(1);
const deadline = setTimeout(() => process.exit(124), 30_000); deadline.unref();
const careProfileId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const source = await sharp(randomBytes(800 * 600 * 3), { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer();
const image = await renderImageInSubprocess(source, "image/png", {
  scriptPath: fileURLToPath(new URL("../../dist/ingest/imageDecodeChild.js", import.meta.url)), timeoutMs: 3000 });
if (image.verdict !== "safe") process.exit(1);
let active = true;
const server = await createAuthorizedTimelineMcpServer({
  authorize: async () => active ? { householdId: "invented-family", userId: "invented-adult" } : null,
  timeline: { profileBelongsToHousehold: async () => true, listApprovedDays: async () => [] },
  pages: { readApprovedPageChunk: async () => null },
  images: { readApprovedImage: async query => query.careProfileId === careProfileId && query.documentId === documentId ? image : null },
});
process.on("SIGUSR2", () => { active = false; process.stderr.write("fictional image grant revoked\n"); });
process.stdin.once("end", () => { clearTimeout(deadline); void server.close(); });
await server.connect(new StdioServerTransport());
