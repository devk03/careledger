import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { MAX_UPLOAD_BYTES, type AdmittedMediaType } from "./admission.js";
import type { StagedOriginal } from "./staging.js";

export class InspectionRejected extends Error {
  constructor(readonly code: "STAGE_CHANGED" | "SCAN_NOT_CLEAN" | "STRUCTURE_REJECTED") {
    super(code);
  }
}

export type MalwareScanner = {
  scan(bytes: Uint8Array, mediaType: AdmittedMediaType): Promise<{
    verdict: "clean" | "detected" | "unavailable";
    engine: string;
  }>;
};
export type StructuralInspector = {
  inspect(bytes: Uint8Array, mediaType: AdmittedMediaType): Promise<{
    status: "safe" | "rejected";
    pageCount: number;
  }>;
};

export type InspectedOriginal = Readonly<{
  staged: StagedOriginal;
  scannerEngine: string;
  pageCount: number;
}>;

const inspected = new WeakSet<object>();

export function isInspectedOriginal(value: unknown): value is InspectedOriginal {
  return typeof value === "object" && value !== null && inspected.has(value);
}

async function verifiedStageBytes(staged: StagedOriginal): Promise<Buffer> {
  if (!Number.isSafeInteger(staged.byteSize) || staged.byteSize < 1 ||
    staged.byteSize > MAX_UPLOAD_BYTES || !/^[0-9a-f]{64}$/.test(staged.sha256))
    throw new InspectionRejected("STAGE_CHANGED");
  const handle = await open(staged.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== staged.byteSize || (before.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && before.uid !== process.getuid()))
      throw new InspectionRejected("STAGE_CHANGED");
    const bytes = Buffer.allocUnsafe(staged.byteSize);
    let position = 0;
    while (position < staged.byteSize) {
      const { bytesRead } = await handle.read(bytes, position, staged.byteSize - position, position);
      if (bytesRead === 0) throw new InspectionRejected("STAGE_CHANGED");
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      createHash("sha256").update(bytes).digest("hex") !== staged.sha256)
      throw new InspectionRejected("STAGE_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Gate before object-store publication. Implementations of scanner and parser
 * must be real, isolated, resource-limited adapters in production. There is
 * deliberately no permissive default or "scanner unavailable = clean" path.
 */
export async function inspectStagedOriginal(
  staged: StagedOriginal,
  scanner: MalwareScanner,
  parser: StructuralInspector,
): Promise<InspectedOriginal> {
  const bytes = await verifiedStageBytes(staged);
  const scan = await scanner.scan(Buffer.from(bytes), staged.mediaType);
  if (scan.verdict !== "clean" || !scan.engine.trim())
    throw new InspectionRejected("SCAN_NOT_CLEAN");
  const parsed = await parser.inspect(Buffer.from(bytes), staged.mediaType);
  if (parsed.status !== "safe" || !Number.isSafeInteger(parsed.pageCount) ||
    parsed.pageCount < 1 || parsed.pageCount > 10_000)
    throw new InspectionRejected("STRUCTURE_REJECTED");
  await verifiedStageBytes(staged);
  const result = Object.freeze({ staged: Object.freeze({ ...staged }),
    scannerEngine: scan.engine, pageCount: parsed.pageCount });
  inspected.add(result);
  return result;
}
