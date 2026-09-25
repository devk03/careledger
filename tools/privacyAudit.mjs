import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { REVIEWED_PUBLIC_WEBP } from "./reviewedPublicAssets.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INSPECT_BYTES = 10 * 1024 * 1024;
const privateSegments = new Set([
  "01_records", "02_extracted", "03_case", "medical-records", "private-records",
  "attachments", "uploads", "backups", "exports", ".local-data", "data",
]);
const reviewedSourcePaths = new Set(["app/backups/__init__.py", "app/backups/service.py"]);
const reviewedPublicWebp = new Map(REVIEWED_PUBLIC_WEBP);
const riskyExtension = /\.(?:pdf|png|jpe?g|heic|tiff?|dcm|docx?|sqlite|db|pem|p12|pfx|key|webp|avif|gif|bmp|svg)$/iu;

export function classifyPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  if (reviewedSourcePaths.has(normalized)) return null;
  if (reviewedPublicWebp.has(normalized)) return null; // The blob digest is checked separately.
  if (parts.some((part) => privateSegments.has(part)))
    return "private-directory";
  if (basename !== ".env.example" && (basename === ".env" ||
    basename.startsWith(".env.") || basename === "case_summary.md" ||
    basename === "current_status.md" || basename === "evidence_registry.md"))
    return "private-name";
  if (riskyExtension.test(basename)) return "risky-extension";
  return null;
}

export function classifyBlob(bytes, paths = []) {
  if (bytes.length > MAX_INSPECT_BYTES) return "large-unreviewed-blob";
  if (paths.some((path) => reviewedPublicWebp.has(path))) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!paths.every((path) => reviewedPublicWebp.get(path) === digest))
      return "unreviewed-image";
  }
  const prefix = bytes.subarray(0, 132);
  if (prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "pdf-signature";
  if (prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg-signature";
  if (prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])))
    return "png-signature";
  if (prefix.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    prefix.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
    return "tiff-signature";
  if (prefix.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
    return "sqlite-signature";
  if (prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    return "archive-signature";
  if (prefix.length >= 132 && prefix.subarray(128, 132).toString("ascii") === "DICM")
    return "dicom-signature";
  if (prefix.length >= 12 && prefix.subarray(4, 12).toString("ascii").startsWith("ftyphei"))
    return "heic-signature";
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP") {
    const digest = createHash("sha256").update(bytes).digest("hex");
    return paths.length > 0 && paths.every((path) => reviewedPublicWebp.get(path) === digest)
      ? null : "unreviewed-image";
  }
  if (prefix.subarray(0, 6).toString("ascii") === "GIF89a" ||
    prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
    prefix.subarray(0, 2).toString("ascii") === "BM" ||
    (prefix.length >= 12 && prefix.subarray(4, 12).toString("ascii").includes("ftypavif")) ||
    /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/iu.test(bytes.subarray(0, 512).toString("utf8")))
    return "unreviewed-image";
  if (bytes.includes(0)) return null; // Other binary files need separate manual review.
  const text = bytes.toString("utf8");
  const secretPrefixes = [
    ["sk", "live"].join("_") + "_",
    ["rk", "live"].join("_") + "_",
    ["ghp", ""].join("_"),
    ["github", "pat", ""].join("_"),
    ["sk", "proj", ""].join("-"),
  ];
  if (secretPrefixes.some((prefixValue) => {
    const index = text.indexOf(prefixValue);
    return index >= 0 && /^[A-Za-z0-9_-]{16,}/u.test(text.slice(index + prefixValue.length));
  })) return "credential-pattern";
  const privateHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const openSshHeader = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
  if (text.includes(privateHeader) || text.includes(openSshHeader))
    return "private-key-header";
  return null;
}

function git(args, options = {}, cwd = repository) {
  return execFileSync("git", args, { cwd, encoding: options.encoding,
    maxBuffer: MAX_INSPECT_BYTES + 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function auditRepository(cwd = repository) {
  const run = (args, options) => git(args, options, cwd);
  const findings = [];
  const blobPaths = new Map();
  const indexRows = run(["ls-files", "--stage", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  const indexObjects = [];
  for (const row of indexRows) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/u.exec(row);
    if (!match) throw new Error("Unmerged or malformed index");
    const [, mode, sha, path] = match;
    if (mode === "120000") findings.push({ category: "symlink", object: "index" });
    const category = classifyPath(path);
    if (category) findings.push({ category, object: "index" });
    indexObjects.push({ sha, path });
  }
  const commits = run(["rev-list", "--all"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const commit of commits) {
    const rows = run(["ls-tree", "-r", "-z", commit], { encoding: "utf8" })
      .split("\0").filter(Boolean);
    for (const row of rows) {
      const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t([\s\S]+)$/u.exec(row);
      if (!match) continue;
      const [, mode, sha, path] = match;
      if (mode === "120000") findings.push({ category: "symlink", object: sha.slice(0, 12) });
      const paths = blobPaths.get(sha) ?? new Set();
      paths.add(path);
      blobPaths.set(sha, paths);
    }
  }
  for (const { sha, path } of indexObjects) {
    const paths = blobPaths.get(sha) ?? new Set();
    paths.add(path);
    blobPaths.set(sha, paths);
  }
  let inspected = 0;
  for (const [sha, paths] of blobPaths) {
    if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new Error("Invalid blob ID");
    for (const path of paths) {
      const category = classifyPath(path);
      if (category) findings.push({ category, object: sha.slice(0, 12) });
    }
    const size = Number(run(["cat-file", "-s", sha], { encoding: "utf8" }).trim());
    if (!Number.isSafeInteger(size) || size > MAX_INSPECT_BYTES) {
      findings.push({ category: "large-unreviewed-blob", object: sha.slice(0, 12) });
      continue;
    }
    const bytes = run(["cat-file", "blob", sha]);
    const category = classifyBlob(bytes, [...paths]);
    if (category) findings.push({ category, object: sha.slice(0, 12) });
    inspected += 1;
  }
  return { inspected, tracked: indexRows.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = auditRepository();
    for (const finding of result.findings) {
      process.stderr.write(`Privacy gate: ${finding.category} (${finding.object})\n`);
    }
    process.stdout.write(`Privacy gate inspected ${result.inspected} historical blobs and ` +
      `${result.tracked} tracked paths; ${result.findings.length} findings.\n`);
    if (result.findings.length > 0) process.exitCode = 1;
  } catch {
    process.stderr.write("Privacy gate could not complete; release remains blocked.\n");
    process.exitCode = 1;
  }
}
