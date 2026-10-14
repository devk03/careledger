import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { OriginalImageReference } from "../timeline/types.js";

export async function readOriginalImage(root: string, reference: OriginalImageReference): Promise<Buffer> {
  if (!isAbsolute(root) || !/^[0-9a-f]{64}$/.test(reference.sourceSha256) ||
    !Number.isSafeInteger(reference.byteSize) || reference.byteSize < 1 || reference.byteSize > MAX_UPLOAD_BYTES ||
    !["image/png", "image/jpeg"].includes(reference.mediaType)) throw new Error("Original unavailable");
  let directory = root;
  for (const shard of ["", reference.sourceSha256.slice(0, 2), reference.sourceSha256.slice(2, 4)]) {
    directory = join(directory, shard);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.())
      throw new Error("Original unavailable");
  }
  const file = await open(join(directory, reference.sourceSha256), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== reference.byteSize || (before.mode & 0o077) || before.uid !== process.getuid?.())
      throw new Error("Original unavailable");
    const bytes = Buffer.alloc(reference.byteSize); let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Original unavailable"); offset += result.bytesRead;
    }
    const after = await file.stat();
    const signature = reference.mediaType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!signature || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== reference.sourceSha256) throw new Error("Original unavailable");
    return bytes;
  } finally { await file.close(); }
}
