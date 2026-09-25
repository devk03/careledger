import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { auditRepository, classifyBlob, classifyPath } from "./privacyAudit.mjs";

test("flags nested record folders and medical file extensions", () => {
  assert.equal(classifyPath("server/uploads/report.pdf"), "private-directory");
  assert.equal(classifyPath("web/public/report.pdf"), "risky-extension");
  assert.equal(classifyPath("docs/report.png"), "risky-extension");
  assert.equal(classifyPath("docs/copied-photo.webp"), "risky-extension");
  assert.equal(classifyPath("server/data/record.bin"), "private-directory");
  assert.equal(classifyPath(".env.production"), "private-name");
  assert.equal(classifyPath(".env.example"), null);
  assert.equal(classifyPath("web/public/images/garden-640.webp"), null);
});

test("sniffs disguised document and database blob signatures", () => {
  assert.equal(classifyBlob(Buffer.from("%PDF-1.7\nfictional")), "pdf-signature");
  assert.equal(classifyBlob(Buffer.from([0xff, 0xd8, 0xff, 0])), "jpeg-signature");
  assert.equal(classifyBlob(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])),
    "png-signature");
  assert.equal(classifyBlob(Buffer.from("SQLite format 3\0fictional")), "sqlite-signature");
  assert.equal(classifyBlob(Buffer.from("RIFFxxxxWEBPfictional"),
    ["web/public/images/garden-640.webp"]), "unreviewed-image");
  const reviewed = readFileSync(new URL("../web/public/images/garden-640.webp", import.meta.url));
  assert.equal(classifyBlob(reviewed, ["web/public/images/garden-640.webp"]), null);
  assert.equal(classifyBlob(Buffer.from("fictional replacement"),
    ["web/public/images/garden-640.webp"]), "unreviewed-image");
  assert.equal(classifyBlob(reviewed, ["docs/copied-photo.webp"]), "unreviewed-image");
  assert.equal(classifyBlob(Buffer.from("GIF89afictional")), "unreviewed-image");
});

test("recognizes high-confidence secret markers without echoing their values", () => {
  const livePrefix = ["sk", "live"].join("_") + "_";
  assert.equal(classifyBlob(Buffer.from(livePrefix + "F".repeat(30))), "credential-pattern");
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  assert.equal(classifyBlob(Buffer.from(header + "\nfictional")), "private-key-header");
});

test("audits staged bytes before commit as well as reachable history", () => {
  const cwd = mkdtempSync(join(tmpdir(), "adeno-fictional-privacy-audit-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "Fictional Tester");
  git("config", "user.email", "fictional@example.invalid");
  writeFileSync(join(cwd, "README.md"), "fictional empty repository\n");
  git("add", "README.md");
  git("commit", "-qm", "fictional first commit");
  writeFileSync(join(cwd, "renamed.txt"), "%PDF-1.7\nfictional test bytes\n");
  symlinkSync("/fictional/private/path", join(cwd, "shortcut.txt"));
  git("add", "renamed.txt");
  git("add", "shortcut.txt");
  const result = auditRepository(cwd);
  assert.ok(result.findings.some((finding) => finding.category === "pdf-signature"));
  assert.ok(result.findings.some((finding) => finding.category === "symlink"));
  assert.equal(result.findings.some((finding) => JSON.stringify(finding).includes("fictional test bytes")),
    false);
});

test("finds a private historical path even when its blob also has a benign path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "adeno-fictional-history-alias-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "Fictional Tester");
  git("config", "user.email", "fictional@example.invalid");
  writeFileSync(join(cwd, "benign.txt"), "fictional harmless text\n");
  git("add", "benign.txt");
  git("commit", "-qm", "fictional benign path");
  const privatePath = join(cwd, "01_records");
  mkdirSync(privatePath);
  writeFileSync(join(privatePath, "renamed.txt"), "fictional harmless text\n");
  git("add", "01_records/renamed.txt");
  git("commit", "-qm", "fictional private alias");
  const result = auditRepository(cwd);
  assert.ok(result.findings.some((finding) => finding.category === "private-directory"));
});
