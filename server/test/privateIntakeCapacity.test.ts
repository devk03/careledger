import { chmod, link, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createPrivateIntakeCapacity } from "../src/ingest/privateIntakeCapacity.js";

it("counts abandoned private stages and pending objects against intake capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-capacity-"));
  const check = createPrivateIntakeCapacity({ roots: [root], maxBytes: 512 * 1024, minimumFreeBytes: 0 });
  expect(await check(1024)).toBe(true);
  await writeFile(join(root, "incoming-invented"), Buffer.alloc(512 * 1024, 7), { mode: 0o600 });
  expect(await check(1024)).toBe(false);
});

it("does not charge immutable hard-link aliases as separate copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-capacity-links-"));
  const file = join(root, "invented-object");
  await writeFile(file, Buffer.alloc(128 * 1024, 4), { mode: 0o600 });
  await link(file, join(root, "pending-invented-alias"));
  const check = createPrivateIntakeCapacity({ roots: [root], maxBytes: 200 * 1024, minimumFreeBytes: 0 });
  expect(await check(1024)).toBe(true);
  await writeFile(join(root, "independent-copy"), Buffer.alloc(128 * 1024, 4), { mode: 0o600 });
  expect(await check(1024)).toBe(false);
});

it("fails closed on links, missing roots and broadly readable storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-capacity-unsafe-"));
  const check = createPrivateIntakeCapacity({ roots: [root], maxBytes: 1024 * 1024, minimumFreeBytes: 0 });
  await chmod(root, 0o755);
  expect(await check(1024)).toBe(false);
  await chmod(root, 0o700);
  await symlink(root, join(root, "loop"));
  expect(await check(1024)).toBe(false);
  const absent = createPrivateIntakeCapacity({ roots: [join(root, "absent")], maxBytes: 1024 * 1024 });
  expect(await absent(1024)).toBe(false);
});

it("rejects invalid reservations and insufficient filesystem free space", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-capacity-free-"));
  const check = createPrivateIntakeCapacity({ roots: [root], maxBytes: 1024 * 1024,
    minimumFreeBytes: Number.MAX_SAFE_INTEGER });
  expect(await check(1024)).toBe(false);
  for (const value of [0, -1, Number.NaN, 0.5, Number.MAX_SAFE_INTEGER]) {
    expect(await check(value)).toBe(false);
  }
});
