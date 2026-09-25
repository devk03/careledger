import { randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { inspectUploadBytes, type AdmissionMetadata } from "./admission.js";

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
  const verified = inspectUploadBytes(bytes, {
    originalName: admission.displayName,
    claimedMediaType: admission.mediaType,
    receivedAt: new Date(admission.receivedAt),
  });
  if (verified.sha256 !== admission.sha256 || verified.byteSize !== admission.byteSize ||
    verified.displayName !== admission.displayName || verified.receivedAt !== admission.receivedAt) {
    throw new StagingIntegrityError();
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) {
    throw new UnsafeStagingRoot();
  }

  const stageId = randomUUID();
  const path = join(root, `incoming-${stageId}`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // fsync the directory too: syncing only the file does not make its newly
  // created name durable across a host crash. An fsync failure leaves a private
  // orphan and fails the upload rather than claiming successful intake.
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }

  return {
    stageId,
    path,
    sha256: verified.sha256,
    byteSize: bytes.byteLength,
    receivedAt: admission.receivedAt,
  };
}
