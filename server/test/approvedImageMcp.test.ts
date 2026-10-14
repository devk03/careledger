import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApprovedImageReader } from "../src/timeline/approvedImage.js";
import { createAuthorizedTimelineMcpServer } from "../src/mcp/authorizedTimeline.js";
import { renderImageInSubprocess } from "../src/ingest/imageDecodeProcess.js";

const scope = { householdId: "invented-family", userId: "invented-adult" };
const careProfileId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adeno-approved-image-"));
  const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#173951" } }).png().toBuffer();
  const reference = { sourceSha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, mediaType: "image/png" as const };
  const directory = join(root, reference.sourceSha256.slice(0, 2), reference.sourceSha256.slice(2, 4));
  await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, reference.sourceSha256);
  await writeFile(path, bytes, { mode: 0o400 });
  let approved = true; let authorized = true; let revokeInRender = false; let revokeSession = false; let renders = 0;
  const images = createApprovedImageReader({ objectRoot: root, repository: { readApprovedImageReference: async input => {
    expect(input).toEqual({ ...scope, careProfileId, documentId }); return approved ? reference : null;
  } }, render: async (data, mediaType) => {
    renders++;
    const result = await renderImageInSubprocess(data, mediaType, { scriptPath: join(process.cwd(), "dist/ingest/imageDecodeChild.js"), timeoutMs: 3000 });
    if (revokeInRender) approved = false; if (revokeSession) authorized = false; return result;
  } });
  const server = await createAuthorizedTimelineMcpServer({ authorize: async () => authorized ? scope : null, images,
    timeline: { profileBelongsToHousehold: async () => true, listApprovedDays: async () => [] },
    pages: { readApprovedPageChunk: async () => null } });
  const client = new Client({ name: "fictional-image-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, bytes, path, reference, renders: () => renders,
    denySource: () => { approved = false; }, revokeDuringRender: () => { revokeInRender = true; },
    revokeSessionDuringRender: () => { revokeSession = true; },
    close: async () => { await client.close(); await server.close(); } };
}
const call = (client: Client) => client.callTool({ name: "get_approved_source_image", arguments: { careProfileId, documentId } });

it("returns standard image content with original/page and rendition digests through an MCP client", async () => {
  const state = await fixture();
  try {
    const tools = await state.client.listTools();
    expect(tools.tools.find(tool => tool.name === "get_approved_source_image")?.annotations?.readOnlyHint).toBe(true);
    const result = await call(state.client); expect(result.isError).not.toBe(true);
    const text = result.content.find(content => content.type === "text"); const image = result.content.find(content => content.type === "image");
    if (text?.type !== "text" || image?.type !== "image") throw new Error("Expected cited image content");
    const citation = JSON.parse(text.text);
    expect(citation).toMatchObject({ careProfileId, documentId, pageNumber: 1, sourceSha256: state.reference.sourceSha256, originalPreserved: true });
    const rendered = Buffer.from(image.data, "base64"); expect(image.mimeType).toBe("image/jpeg");
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(citation.rendition.sha256);
    expect(await readFile(state.path)).toEqual(state.bytes);
  } finally { await state.close(); }
});

it("does not render an unpublished or source-denied document", async () => {
  const state = await fixture();
  try { state.denySource(); const result = await call(state.client);
    expect(result.isError).toBe(true); expect(result.content.every(content => content.type === "text")).toBe(true); expect(state.renders()).toBe(0);
  } finally { await state.close(); }
});

it("withholds rendered pixels when source/day access or the connection is revoked during rendering", async () => {
  for (const session of [false, true]) {
    const state = await fixture();
    try {
      if (session) state.revokeSessionDuringRender(); else state.revokeDuringRender();
      const result = await call(state.client); expect(result.isError).toBe(true);
      expect(result.content.every(content => content.type === "text")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(state.reference.sourceSha256);
    } finally { await state.close(); }
  }
});
