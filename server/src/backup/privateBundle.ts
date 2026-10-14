import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { MAX_UPLOAD_BYTES } from "../ingest/admission.js";

const MAGIC = Buffer.from("adeno-private-bundle-v1\n");
const MAX_TOTAL = 1024 * 1024 * 1024;
const memberSchema = z.object({ kind: z.enum(["database", "recovery_pepper", "object"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive().max(MAX_TOTAL) }).strict();
const manifestSchema = z.object({ format: z.literal("adeno.private-bundle.v1"),
  members: z.array(memberSchema).min(2).max(5002) }).strict().superRefine((value, ctx) => {
  const members = value.members;
  if (members.filter(m => m.kind === "database").length !== 1 ||
    members.filter(m => m.kind === "recovery_pepper").length !== 1 ||
    members.some(m => m.kind === "recovery_pepper" && m.bytes !== 32) ||
    members.some(m => m.kind === "object" && m.bytes > MAX_UPLOAD_BYTES) ||
    new Set(members.map(m => `${m.kind}:${m.sha256}`)).size !== members.length ||
    members.reduce((total, member) => total + member.bytes, 0) > MAX_TOTAL - 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "Invalid private bundle inventory" });
});
export type PrivateBundleMember = z.infer<typeof memberSchema>;
export class PrivateBundleError extends Error {
  constructor() { super("Private backup bundle is unavailable or invalid"); }
}
async function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new PrivateBundleError();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.())
    throw new PrivateBundleError();
}
async function privateFile(path: string) {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const info = await file.stat();
  if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.()) {
    await file.close(); throw new PrivateBundleError();
  }
  return { file, info };
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

/** Fixed logical member types, never archive-supplied filenames or extraction paths. */
export async function writePrivateBundle(input: {
  members: (PrivateBundleMember & { path: string })[]; destination: string;
}) {
  try {
    const members = input.members.map(member => Object.freeze({ ...member }));
    await privateDirectory(dirname(input.destination));
    const manifest = manifestSchema.parse({ format: "adeno.private-bundle.v1",
      members: members.map(({ path: _path, ...member }) => member) });
    const wire = Buffer.from(JSON.stringify(manifest));
    if (wire.length > 1024 * 1024) throw new PrivateBundleError();
    const pending = join(dirname(input.destination), `pending-bundle-${randomUUID()}`);
    const output = await open(pending, "wx", 0o600);
    try {
      const length = Buffer.alloc(4); length.writeUInt32BE(wire.length);
      await output.writeFile(Buffer.concat([MAGIC, length, wire]));
      for (const member of members) {
        const source = await privateFile(member.path);
        try {
          if (source.info.size !== member.bytes) throw new PrivateBundleError();
          const digest = createHash("sha256"); let copied = 0;
          const chunk = Buffer.alloc(64 * 1024);
          while (copied < member.bytes) {
            const result = await source.file.read(chunk, 0, Math.min(chunk.length, member.bytes - copied), copied);
            if (!result.bytesRead) throw new PrivateBundleError();
            const bytes = chunk.subarray(0, result.bytesRead); digest.update(bytes); await output.writeFile(bytes);
            copied += bytes.length;
          }
          const after = await source.file.stat();
          if (digest.digest("hex") !== member.sha256 || after.size !== source.info.size ||
            after.mtimeMs !== source.info.mtimeMs || after.ctimeMs !== source.info.ctimeMs) throw new PrivateBundleError();
        } finally { await source.file.close(); }
      }
      await output.sync();
    } finally { await output.close(); }
    await link(pending, input.destination); await syncDirectory(dirname(input.destination));
    return manifest;
  } catch { throw new PrivateBundleError(); }
}

/** Writes into a newly reserved private root. Only verified state becomes root/data. */
export async function restorePrivateBundle(input: {
  bundlePath: string; destinationRoot: string;
  verifyState: (dataRoot: string, members: PrivateBundleMember[]) => Promise<void>;
}) {
  let source: Awaited<ReturnType<typeof privateFile>> | undefined;
  try {
    await privateDirectory(dirname(input.destinationRoot));
    source = await privateFile(input.bundlePath);
    if (source.info.size > MAX_TOTAL) throw new PrivateBundleError();
    let offset = 0;
    const take = async (length: number) => {
      const bytes = Buffer.alloc(length); let read = 0;
      while (read < length) {
        const result = await source!.file.read(bytes, read, length - read, offset + read);
        if (!result.bytesRead) throw new PrivateBundleError(); read += result.bytesRead;
      }
      offset += length; return bytes;
    };
    if (!(await take(MAGIC.length)).equals(MAGIC)) throw new PrivateBundleError();
    const length = (await take(4)).readUInt32BE(0);
    if (length < 1 || length > 1024 * 1024) throw new PrivateBundleError();
    const manifest = manifestSchema.parse(JSON.parse((await take(length)).toString("utf8")));
    if (offset + manifest.members.reduce((total, member) => total + member.bytes, 0) !== source.info.size)
      throw new PrivateBundleError();
    await mkdir(input.destinationRoot, { mode: 0o700 }); // Existing destinations fail; never merge or overwrite.
    const pending = join(input.destinationRoot, "pending"); await mkdir(pending, { mode: 0o700 });
    await syncDirectory(dirname(input.destinationRoot)); await syncDirectory(input.destinationRoot);
    for (const member of manifest.members) {
      let path: string;
      if (member.kind === "database") path = join(pending, "case.sqlite");
      else if (member.kind === "recovery_pepper") {
        const secrets = join(pending, "secrets"); await mkdir(secrets, { mode: 0o700 });
        await syncDirectory(pending);
        path = join(secrets, "recovery-pepper");
      } else {
        let parent = pending;
        for (const segment of ["objects", member.sha256.slice(0, 2), member.sha256.slice(2, 4)]) {
          parent = join(parent, segment); try { await mkdir(parent, { mode: 0o700 }); await syncDirectory(dirname(parent)); }
          catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
        }
        path = join(parent, member.sha256);
      }
      const file = await open(path, "wx", 0o600); const digest = createHash("sha256");
      try {
        let remaining = member.bytes;
        while (remaining) { const bytes = await take(Math.min(64 * 1024, remaining)); digest.update(bytes); await file.writeFile(bytes); remaining -= bytes.length; }
        if (digest.digest("hex") !== member.sha256) throw new PrivateBundleError();
        if (member.kind === "object") await file.chmod(0o400);
        await file.sync();
      } finally { await file.close(); }
      await syncDirectory(dirname(path));
    }
    await input.verifyState(pending, manifest.members);
    await syncDirectory(pending);
    await rename(pending, join(input.destinationRoot, "data")); await syncDirectory(input.destinationRoot);
    return { dataRoot: join(input.destinationRoot, "data"), members: manifest.members };
  } catch { throw new PrivateBundleError(); }
  finally { await source?.file.close(); }
}
