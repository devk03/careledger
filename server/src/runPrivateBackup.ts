import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { createPrivateBackupIdentity } from "./backup/privateAgeFile.js";
import { createPrivateSnapshot, restorePrivateSnapshot } from "./backup/privateSnapshot.js";

const path = z.string().min(1).max(4096).refine(isAbsolute);
const configuration = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keygen"), identityPath: path }).strict(),
  z.object({ action: z.literal("snapshot"), sourceDbPath: path, objectRoot: path,
    recoveryPepperPath: path, snapshotRoot: path, encryptedPath: path,
    recipient: z.string().min(20).max(4096), writersStopped: z.literal(true) }).strict(),
  z.object({ action: z.literal("restore"), encryptedPath: path,
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/), identityPath: path,
    workRoot: path, destinationRoot: path }).strict(),
]);

async function readConfiguration(configPath: string) {
  if (!isAbsolute(configPath)) throw new Error("Invalid configuration");
  const parent = await lstat(dirname(configPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid?.())
    throw new Error("Invalid configuration");
  const file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 16 * 1024 || (before.mode & 0o077) || before.uid !== process.getuid?.())
      throw new Error("Invalid configuration");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Invalid configuration"); offset += result.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Invalid configuration");
    return configuration.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally { await file.close(); }
}

process.umask(0o077);
// No service/monitor is installed. Partial work remains private and recoverable.
const deadline = setTimeout(() => {
  process.stderr.write("Private backup command exceeded its finite deadline\n"); process.exit(1);
}, 15 * 60 * 1000);
try {
  if (process.argv.length !== 3) throw new Error("Invalid arguments");
  const config = await readConfiguration(process.argv[2]!);
  if (config.action === "keygen") {
    const result = await createPrivateBackupIdentity(config.identityPath);
    process.stdout.write(`${JSON.stringify({ action: "keygen", recipient: result.recipient })}\n`);
  } else if (config.action === "snapshot") {
    const result = await createPrivateSnapshot(config);
    process.stdout.write(`${JSON.stringify({ action: "snapshot", sha256: result.sha256, bytes: result.bytes })}\n`);
  } else {
    await restorePrivateSnapshot(config);
    process.stdout.write(`${JSON.stringify({ action: "restore", verified: true })}\n`);
  }
} catch {
  process.stderr.write("Private backup command failed; check private configuration and retained outputs\n");
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
