import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { inspectUploadBytes, MAX_UPLOAD_BYTES, UploadAdmissionError,
  type AdmittedMediaType,
  type AdmissionMetadata } from "./admission.js";

export class StagingIntegrityError extends Error {
  constructor() {
    super("Admission metadata did not match original bytes");
  }
}

export class UnsafeStagingRoot extends Error {
  constructor() {
    super("Staging root must be a real directory, not a symbolic link");
  }
}

export type StagedOriginal = {
  stageId: string;
  path: string;
  sha256: string;
  byteSize: number;
  mediaType: AdmittedMediaType;
  receivedAt: string;
};

/**
 * Writes original bytes once into a private quarantine directory. This is not
 * promotion: staged files must not be rendered, served or linked to a day.
 */
export async function stageOriginalBytes(
  root: string,
  bytes: Uint8Array,
  admission: AdmissionMetadata,
): Promise<StagedOriginal> {
  if (!isAbsolute(root)) throw new UnsafeStagingRoot();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadAdmissionError("UPLOAD_TOO_LARGE");
  // Take ownership of a bounded snapshot before the first await. A caller may
  // otherwise mutate its Uint8Array after validation but before writeFile.
  const snapshot = Uint8Array.from(bytes);
  const verified = inspectUploadBytes(snapshot, {
    originalName: admission.displayName,
    claimedMediaType: admission.mediaType,
    receivedAt: new Date(admission.receivedAt),
  });
  if (verified.sha256 !== admission.sha256 || verified.byteSize !== admission.byteSize ||
    verified.displayName !== admission.displayName || verified.receivedAt !== admission.receivedAt) {
    throw new StagingIntegrityError();
  }

  // Provision the root separately. Creating it inside an upload request would
  // require syncing newly created parent entries before reporting durability.
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  let canonicalRoot: string;
  try {
    rootInfo = await lstat(root);
    canonicalRoot = await realpath(root);
  } catch {
    throw new UnsafeStagingRoot();
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && rootInfo.uid !== process.getuid())) {
    throw new UnsafeStagingRoot();
  }

  const stageId = randomUUID();
  const path = join(canonicalRoot, `incoming-${stageId}`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(snapshot);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // fsync the directory too: syncing only the file does not make its newly
  // created name durable across a host crash. An fsync failure leaves a private
  // orphan and fails the upload rather than claiming successful intake.
  const directory = await open(canonicalRoot, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }

  return {
    stageId,
    path,
    sha256: verified.sha256,
    byteSize: snapshot.byteLength,
    mediaType: verified.mediaType,
    receivedAt: admission.receivedAt,
  };
}
