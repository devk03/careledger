import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { REVIEWED_PUBLIC_WEBP } from "./reviewedPublicAssets.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function matchesReviewedDigest(bytes, expectedSha256) {
  return createHash("sha256").update(bytes).digest("hex") === expectedSha256;
}

export function verifyPublicAssets(root = repository) {
  for (const [path, digest] of REVIEWED_PUBLIC_WEBP) {
    const absolute = resolve(root, path);
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 ||
      !matchesReviewedDigest(readFileSync(absolute), digest))
      throw new Error("A public illustration differs from its reviewed version.");
  }
  return REVIEWED_PUBLIC_WEBP.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = verifyPublicAssets();
    process.stdout.write(`Verified ${count} reviewed public illustrations.\n`);
  } catch {
    process.stderr.write("Public illustration verification failed; release remains blocked.\n");
    process.exitCode = 1;
  }
}
