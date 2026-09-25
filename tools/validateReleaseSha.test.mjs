import assert from "node:assert/strict";
import { test } from "node:test";

import { validateReleaseSha } from "./validateReleaseSha.mjs";

test("self-hosted builds may omit a public revision", () => {
  assert.equal(validateReleaseSha("", "0"), null);
});

test("release builds require a full lowercase public revision", () => {
  const sha = "a".repeat(40);
  assert.equal(validateReleaseSha(sha, "1"), sha);
  for (const invalid of ["", "a".repeat(39), "A".repeat(40), "g".repeat(40)]) {
    assert.throws(() => validateReleaseSha(invalid, "1"));
  }
});

test("malformed supplied revisions fail even in self-hosted builds", () => {
  assert.throws(() => validateReleaseSha("not-a-sha", "0"));
  assert.throws(() => validateReleaseSha("a".repeat(40), "true"));
});
