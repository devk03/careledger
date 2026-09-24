/** Bounded fictional-data admission and private-staging load check. */
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { inspectUploadBytes } from "../dist/ingest/admission.js";
import { stageOriginalBytes } from "../dist/ingest/staging.js";

const prefix = Buffer.from("%PDF-1.7\nSYNTHETIC TEST RECORD — NO PATIENT DATA\n");
const bytes = Buffer.concat([prefix, randomBytes(32 * 1024), Buffer.from("\n%%EOF\n")]);
const receivedAt = new Date("2030-01-01T00:00:00Z");
const admissionDurations = [];
for (let index = 0; index < 5000; index += 1) {
  const started = performance.now();
  const admitted = inspectUploadBytes(bytes, {
    originalName: `fictional-${index}.pdf`,
    receivedAt,
  });
  if (admitted.byteSize !== bytes.length || admitted.mediaType !== "application/pdf") {
    throw new Error("Synthetic admission mismatch");
  }
  admissionDurations.push(performance.now() - started);
}

// Leave this tiny fictional directory in the OS temporary area; never touch
// application storage or delete files as part of a stress run.
const root = await mkdtemp(join(tmpdir(), "adeno-fictional-stress-"));
const count = 100;
let next = 0;
const staged = [];
const stagingDurations = [];
await Promise.all(Array.from({ length: 10 }, async () => {
  while (next < count) {
    const index = next++;
    const admitted = inspectUploadBytes(bytes, {
      originalName: `fictional-stage-${index}.pdf`,
      receivedAt,
    });
    const started = performance.now();
    const result = await stageOriginalBytes(root, bytes, admitted);
    stagingDurations.push(performance.now() - started);
    staged.push(result);
  }
}));

const onDisk = await readdir(root);
if (onDisk.length !== count || new Set(staged.map((item) => item.path)).size !== count) {
  throw new Error("Synthetic staged-file count or uniqueness mismatch");
}
for (const file of staged) {
  const [content, metadata] = await Promise.all([readFile(file.path), stat(file.path)]);
  if (!content.equals(bytes) || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Synthetic staged-file integrity or permission mismatch");
  }
}

function percentile(values, fraction) {
  const sorted = values.toSorted((left, right) => left - right);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
}

console.log(JSON.stringify({
  fictionalOnly: true,
  admission: {
    operations: admissionDurations.length,
    bytesPerFile: bytes.length,
    p50Ms: percentile(admissionDurations, 0.5),
    p95Ms: percentile(admissionDurations, 0.95),
    p99Ms: percentile(admissionDurations, 0.99),
  },
  staging: {
    files: staged.length,
    concurrency: 10,
    p50Ms: percentile(stagingDurations, 0.5),
    p95Ms: percentile(stagingDurations, 0.95),
    p99Ms: percentile(stagingDurations, 0.99),
    bytesVerified: staged.reduce((sum, file) => sum + file.byteSize, 0),
  },
  temporaryDirectory: root,
}));
