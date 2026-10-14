import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTrustedIntake, type TrustedIntakeRepository } from "../src/ingest/trustedIntake.js";
import { isInspectedOriginal, type MalwareScanner } from "../src/ingest/inspection.js";

// Invented signature-bearing transport bytes; the injected parser is a test double.
// These tests do not establish that an actual PNG decoder accepts this payload.
const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.from("fictional intake")]);
const request = { preflight: { ok: true as const, tokenSha256: "a".repeat(64), csrfToken: "fictional" },
  careProfileId: "invented-profile", bytes, originalName: "invented.png", claimedMediaType: "image/png" };
async function fixture(repository: TrustedIntakeRepository, scanner?: MalwareScanner) {
  const quarantineRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-intake-quarantine-"));
  const objectRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-intake-objects-"));
  const intake = createTrustedIntake({ repository, quarantineRoot, objectRoot,
    storageAvailable: async () => true,
    scanner: scanner ?? { scan: async () => ({ verdict: "clean", engine: "fictional-test" }) },
    parser: { inspect: async () => ({ status: "safe", pageCount: 1 }) } });
  return { intake, quarantineRoot, objectRoot };
}

it("requires fresh permission before staging any private bytes", async () => {
  const state = await fixture({ checkDocumentIntake: () => ({ ok: false, status: 403, error: "FORBIDDEN" }),
    recordInspectedOriginal: () => { throw new Error("No metadata write permitted"); } });
  expect(await state.intake(request)).toEqual({ ok: false, status: 403, error: "FORBIDDEN" });
  expect(await readdir(state.quarantineRoot)).toEqual([]);
  expect(await readdir(state.objectRoot)).toEqual([]);
});

it("preserves exact originals and requires opaque inspection proof before recording metadata", async () => {
  let recorded = false;
  const state = await fixture({ checkDocumentIntake: () => ({ ok: true }),
    recordInspectedOriginal: input => {
      expect(isInspectedOriginal(input.inspection)).toBe(true);
      expect(input.stored.sha256).toBe(input.admission.sha256);
      recorded = true;
      return { ok: true, documentId: "invented-document", alreadyExisted: false };
    } });
  expect(await state.intake(request)).toMatchObject({ ok: true, documentId: "invented-document" });
  expect(recorded).toBe(true);
  const [stage] = await readdir(state.quarantineRoot);
  expect(await readFile(join(state.quarantineRoot, stage!))).toEqual(bytes);
});

it("keeps failed scans quarantined without recording or publishing an object", async () => {
  const state = await fixture({ checkDocumentIntake: () => ({ ok: true }),
    recordInspectedOriginal: () => { throw new Error("Failed scan must not be recorded"); } },
    { scan: async () => ({ verdict: "unavailable", engine: "fictional-test" }) });
  expect(await state.intake(request)).toEqual({ ok: false, status: 422, error: "UPLOAD_NOT_ACCEPTED" });
  expect(await readdir(state.objectRoot)).toEqual([]);
  expect(await readdir(state.quarantineRoot)).toHaveLength(1);
});

it("honors permission revocation at the final transactional metadata boundary", async () => {
  let active = true;
  const state = await fixture({ checkDocumentIntake: () => ({ ok: true }),
    recordInspectedOriginal: () => active ? { ok: true, documentId: "unexpected", alreadyExisted: false }
      : { ok: false, status: 401, error: "AUTH_REQUIRED" } },
    { scan: async () => { active = false; return { verdict: "clean", engine: "fictional-test" }; } });
  expect(await state.intake(request)).toEqual({ ok: false, status: 401, error: "AUTH_REQUIRED" });
});

it("rejects PDFs and scanner failures without returning document text or diagnostics", async () => {
  const state = await fixture({ checkDocumentIntake: () => ({ ok: true }),
    recordInspectedOriginal: () => { throw new Error("Must not record"); } },
    { scan: async () => { throw new Error("private diagnostic and fictional source text"); } });
  expect(await state.intake({ ...request, claimedMediaType: "application/pdf" }))
    .toEqual({ ok: false, status: 415, error: "UNSUPPORTED_TYPE" });
  expect(await state.intake(request)).toEqual({ ok: false, status: 503, error: "INTAKE_UNAVAILABLE" });
});

it("bounds concurrent work and releases capacity after a failed pipeline", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const state = await fixture({ checkDocumentIntake: () => ({ ok: true }),
    recordInspectedOriginal: () => ({ ok: true, documentId: "invented-document", alreadyExisted: false }) },
    { scan: async () => { await wait; return { verdict: "unavailable", engine: "fictional-test" }; } });
  const first = state.intake(request);
  expect(await state.intake(request)).toMatchObject({ status: 429, error: "INTAKE_BUSY" });
  release();
  expect(await first).toMatchObject({ status: 422 });
  expect(await state.intake(request)).toMatchObject({ status: 422 });
});

it("rejects physical capacity exhaustion before leaving a staging artifact", async () => {
  const quarantineRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-intake-full-"));
  const objectRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-intake-full-objects-"));
  const intake = createTrustedIntake({ quarantineRoot, objectRoot,
    repository: { checkDocumentIntake: () => ({ ok: true }), recordInspectedOriginal: () => {
      throw new Error("Capacity denial must not record metadata");
    } },
    storageAvailable: async additionalBytes => { expect(additionalBytes).toBe(bytes.length * 2); return false; },
    scanner: { scan: async () => { throw new Error("Capacity denial must not scan"); } },
    parser: { inspect: async () => { throw new Error("Capacity denial must not decode"); } } });
  expect(await intake(request)).toEqual({ ok: false, status: 503, error: "STORAGE_UNAVAILABLE" });
  expect(await readdir(quarantineRoot)).toEqual([]);
});

it("owns a byte and authorization snapshot across asynchronous scanning", async () => {
  const mutable = { ...request, preflight: { ...request.preflight }, bytes: Buffer.from(bytes) };
  const state = await fixture({ checkDocumentIntake: () => ({ ok: true }),
    recordInspectedOriginal: input => {
      expect(input.careProfileId).toBe("invented-profile");
      expect(input.preflight.tokenSha256).toBe("a".repeat(64));
      return { ok: true, documentId: "invented-document", alreadyExisted: false };
    } }, { scan: async scanned => {
      expect(Buffer.from(scanned)).toEqual(bytes);
      mutable.bytes.fill(0); mutable.careProfileId = "other-profile";
      mutable.preflight.tokenSha256 = "b".repeat(64);
      return { verdict: "clean", engine: "fictional-test" };
    } });
  expect(await state.intake(mutable)).toMatchObject({ ok: true });
  const [stage] = await readdir(state.quarantineRoot);
  expect(await readFile(join(state.quarantineRoot, stage!))).toEqual(bytes);
});
