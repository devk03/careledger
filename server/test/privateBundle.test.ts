import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { restorePrivateBundle, writePrivateBundle, type PrivateBundleMember } from "../src/backup/privateBundle.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-bundle-"));
  const members: (PrivateBundleMember & { path: string })[] = [];
  for (const [kind, bytes] of [["database", Buffer.from("INVENTED DATABASE BYTES, NOT SQLITE")],
    ["recovery_pepper", Buffer.alloc(32, 7)], ["object", Buffer.from("Independently invented original.")]] as const) {
    const path = join(root, kind); await writeFile(path, bytes, { mode: 0o600 });
    members.push({ kind, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const bundlePath = join(root, "bundle"); await writePrivateBundle({ destination: bundlePath, members });
  return { root, members, bundlePath };
}

it("restores only fixed member paths after exact digest checks and a required state verifier", async () => {
  const state = await fixture(); let verified = false;
  const restored = await restorePrivateBundle({ bundlePath: state.bundlePath, destinationRoot: join(state.root, "restored"),
    verifyState: async root => { expect(await readFile(join(root, "secrets", "recovery-pepper"))).toEqual(Buffer.alloc(32, 7)); verified = true; } });
  expect(verified).toBe(true);
  expect(await readFile(join(restored.dataRoot, "case.sqlite"))).toEqual(await readFile(state.members[0]!.path));
  const object = state.members[2]!;
  const path = join(restored.dataRoot, "objects", object.sha256.slice(0, 2), object.sha256.slice(2, 4), object.sha256);
  expect((await stat(path)).mode & 0o777).toBe(0o400);
});

it("does not publish data after tampering, trailing bytes or failed application verification", async () => {
  const state = await fixture(); const original = await readFile(state.bundlePath);
  for (const [index, bytes] of [Buffer.concat([original, Buffer.from("extra")]),
    Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([0])])].entries()) {
    const path = join(state.root, `invalid-${index}`); await writeFile(path, bytes, { mode: 0o600 });
    const destinationRoot = join(state.root, `denied-${index}`);
    await expect(restorePrivateBundle({ bundlePath: path, destinationRoot, verifyState: async () => {} })).rejects.toThrow();
    await expect(stat(join(destinationRoot, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  const destinationRoot = join(state.root, "state-denied");
  await expect(restorePrivateBundle({ ...state, destinationRoot, verifyState: async () => { throw new Error("Invalid application state"); } })).rejects.toThrow();
  await expect(stat(join(destinationRoot, "data"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves existing bundles and restore roots rather than overwriting", async () => {
  const state = await fixture();
  await expect(writePrivateBundle({ destination: state.bundlePath, members: state.members })).rejects.toThrow();
  await expect(restorePrivateBundle({ ...state, destinationRoot: state.root, verifyState: async () => {} })).rejects.toThrow();
  expect(await readFile(state.members[0]!.path)).toEqual(Buffer.from("INVENTED DATABASE BYTES, NOT SQLITE"));
});
