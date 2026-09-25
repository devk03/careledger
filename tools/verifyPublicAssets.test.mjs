import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { REVIEWED_PUBLIC_WEBP } from "./reviewedPublicAssets.mjs";
import { matchesReviewedDigest, verifyPublicAssets } from "./verifyPublicAssets.mjs";

test("only the five reviewed public illustrations match their pinned bytes", () => {
  assert.equal(verifyPublicAssets(), 5);
  const [path, digest] = REVIEWED_PUBLIC_WEBP[0];
  const original = readFileSync(new URL(`../${path}`, import.meta.url));
  assert.equal(matchesReviewedDigest(original, digest), true);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  assert.equal(matchesReviewedDigest(changed, digest), false);
});

test("a changed worktree illustration blocks packaging even when Git is unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "adeno-fictional-public-assets-"));
  for (const [path] of REVIEWED_PUBLIC_WEBP) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(`../${path}`, import.meta.url), destination);
  }
  assert.equal(verifyPublicAssets(root), 5);
  const replacedPath = join(root, REVIEWED_PUBLIC_WEBP[0][0]);
  const replaced = readFileSync(replacedPath);
  replaced[replaced.length - 1] ^= 1;
  writeFileSync(replacedPath, replaced);
  assert.throws(() => verifyPublicAssets(root), /differs from its reviewed version/u);
});
