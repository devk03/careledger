import { inspectUploadBytes, MAX_UPLOAD_BYTES, UploadAdmissionError,
  type AdmissionMetadata } from "./admission.js";
import { inspectStagedOriginal, InspectionRejected, type InspectedOriginal,
  type MalwareScanner, type StructuralInspector } from "./inspection.js";
import { commitStagedObject, type StoredOriginal } from "./objectStore.js";
import { stageOriginalBytes } from "./staging.js";
import type { MutationPreflight } from "../auth/cookieSession.js";

type Preflight = Extract<MutationPreflight, { ok: true }>;
export type IntakeDenial = { ok: false; status: 401 | 403 | 404; error: string };
export type IntakeReceipt = { ok: true; documentId: string; alreadyExisted: boolean };

export interface TrustedIntakeRepository {
  /** Fresh session/CSRF and profile intake rights, before private staging. */
  checkDocumentIntake(input: { preflight: Preflight; careProfileId: string }):
    { ok: true } | IntakeDenial;
  /** Recheck rights inside the same transaction as metadata + audit insertion. */
  recordInspectedOriginal(input: { preflight: Preflight; careProfileId: string;
    admission: Readonly<AdmissionMetadata>; inspection: InspectedOriginal; stored: StoredOriginal }):
    IntakeReceipt | IntakeDenial;
}

export type TrustedIntakeResult = IntakeReceipt | IntakeDenial | {
  ok: false; status: 400 | 413 | 415 | 422 | 429 | 503;
  error: "INVALID_UPLOAD" | "UPLOAD_TOO_LARGE" | "UNSUPPORTED_TYPE" |
    "UPLOAD_NOT_ACCEPTED" | "INTAKE_BUSY" | "STORAGE_UNAVAILABLE" | "INTAKE_UNAVAILABLE";
};

/**
 * Joins existing inspection and durable storage to a transactional metadata writer.
 * This does not mount a route or enable a format whose production gate is closed.
 * Real deployments must supply isolated scanners/parsers and physical capacity admission.
 * Interrupted/rejected attempts retain private staging/orphans, never published days.
 */
export function createTrustedIntake(input: {
  repository: TrustedIntakeRepository; scanner: MalwareScanner; parser: StructuralInspector;
  quarantineRoot: string; objectRoot: string;
  /** Reserve room for the stage and possible object copy, including existing orphans. */
  storageAvailable: (additionalBytes: number) => Promise<boolean>;
}) {
  let active = false; // One bounded pipeline in this single-writer private MVP.
  return async (request: {
    preflight: Preflight; careProfileId: string;
    bytes: Uint8Array; originalName: string; claimedMediaType: string;
  }): Promise<TrustedIntakeResult> => {
    if (active) return { ok: false, status: 429, error: "INTAKE_BUSY" };
    if (request.bytes.byteLength > MAX_UPLOAD_BYTES)
      return { ok: false, status: 413, error: "UPLOAD_TOO_LARGE" };
    const preflight = Object.freeze({ ...request.preflight });
    const careProfileId = request.careProfileId;
    const bytes = Uint8Array.from(request.bytes);
    const originalName = request.originalName;
    const claimedMediaType = request.claimedMediaType;
    active = true;
    try {
      const authorized = input.repository.checkDocumentIntake({ preflight, careProfileId });
      if (!authorized.ok) return authorized;
      // PDFs remain closed until the separate full-file PDF gate passes.
      if (!["image/png", "image/jpeg"].includes(claimedMediaType))
        return { ok: false, status: 415, error: "UNSUPPORTED_TYPE" };
      const admission = Object.freeze(inspectUploadBytes(bytes, { originalName, claimedMediaType }));
      if (!await input.storageAvailable(bytes.byteLength * 2))
        return { ok: false, status: 503, error: "STORAGE_UNAVAILABLE" };
      const staged = await stageOriginalBytes(input.quarantineRoot, bytes, admission);
      const inspection = await inspectStagedOriginal(staged, input.scanner, input.parser);
      const stored = await commitStagedObject(input.objectRoot, input.quarantineRoot, inspection);
      return input.repository.recordInspectedOriginal({ preflight, careProfileId, admission, inspection, stored });
    } catch (error) {
      if (error instanceof UploadAdmissionError) return { ok: false,
        status: error.code === "UPLOAD_TOO_LARGE" ? 413 : 400,
        error: error.code === "UPLOAD_TOO_LARGE" ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD" };
      if (error instanceof InspectionRejected)
        return { ok: false, status: 422, error: "UPLOAD_NOT_ACCEPTED" };
      return { ok: false, status: 503, error: "INTAKE_UNAVAILABLE" };
    } finally { active = false; }
  };
}
