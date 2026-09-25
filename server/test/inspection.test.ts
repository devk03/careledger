import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectUploadBytes } from "../src/ingest/admission.js";
import { inspectStagedOriginal, InspectionRejected,
  isInspectedOriginal } from "../src/ingest/inspection.js";
import { stageOriginalBytes } from "../src/ingest/staging.js";
import { MAX_PDF_PAGES } from "../src/ingest/policy.js";

const fictionalPdf = Buffer.from("%PDF-1.7\nFICTIONAL INSPECTION ONLY\n%%EOF");

async function staged() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-inspection-"));
  const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
  return stageOriginalBytes(root, fictionalPdf, admission);
}

describe("explicit scan and structural-inspection gate", () => {
  it("requires both clearances and keeps scanner mutations away from the staged original", async () => {
    const original = await staged();
    const result = await inspectStagedOriginal(original,
      { scan: async (bytes) => {
        bytes[0] = 0;
        return { verdict: "clean", engine: "fictional-test-scanner" };
      } },
      { inspect: async (bytes) => {
        expect(Buffer.from(bytes)).toEqual(fictionalPdf);
        return { status: "safe", pageCount: 1 };
      } });
    expect(isInspectedOriginal(result)).toBe(true);
    expect(isInspectedOriginal({ ...result })).toBe(false);
    expect(await readFile(original.path)).toEqual(fictionalPdf);
  });

  it("fails closed when scanning is unavailable or detects content", async () => {
    const original = await staged();
    let parserCalls = 0;
    for (const verdict of ["unavailable", "detected"] as const) {
      await expect(inspectStagedOriginal(original,
        { scan: async () => ({ verdict, engine: "fictional-test-scanner" }) },
        { inspect: async () => { parserCalls += 1; return { status: "safe", pageCount: 1 }; } }))
        .rejects.toMatchObject({ code: "SCAN_NOT_CLEAN" } satisfies Partial<InspectionRejected>);
    }
    expect(parserCalls).toBe(0);
  });

  it("rejects structurally unsafe files and invalid page counts", async () => {
    const original = await staged();
    for (const outcome of [
      { status: "rejected" as const, pageCount: 1 },
      { status: "safe" as const, pageCount: 0 },
      { status: "safe" as const, pageCount: MAX_PDF_PAGES + 1 },
    ]) {
      await expect(inspectStagedOriginal(original,
        { scan: async () => ({ verdict: "clean", engine: "fictional-test-scanner" }) },
        { inspect: async () => outcome }))
        .rejects.toMatchObject({ code: "STRUCTURE_REJECTED" });
    }
  });

  it("does not accept bytes substituted while the scanner is awaited", async () => {
    const original = await staged();
    const callerOwned = { ...original };
    const replacement = Buffer.from(fictionalPdf);
    replacement[10] = replacement[10]! ^ 1;
    await expect(inspectStagedOriginal(callerOwned,
      { scan: async () => {
        await writeFile(original.path, replacement);
        callerOwned.sha256 = createHash("sha256").update(replacement).digest("hex");
        return { verdict: "clean", engine: "fictional-test-scanner" };
      } },
      { inspect: async () => ({ status: "safe", pageCount: 1 }) }))
      .rejects.toMatchObject({ code: "STAGE_CHANGED" });
  });

  it("checks detected bytes against the claimed media type before scanning", async () => {
    const original = await staged();
    let scannerCalls = 0;
    await expect(inspectStagedOriginal({ ...original, mediaType: "image/png" },
      { scan: async () => {
        scannerCalls += 1;
        return { verdict: "clean", engine: "fictional-test-scanner" };
      } },
      { inspect: async () => ({ status: "safe", pageCount: 1 }) }))
      .rejects.toMatchObject({ code: "STAGE_CHANGED" });
    expect(scannerCalls).toBe(0);
  });
});
