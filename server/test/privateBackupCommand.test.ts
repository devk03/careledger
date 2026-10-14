import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const command = fileURLToPath(new URL("../dist/runPrivateBackup.js", import.meta.url));
async function fixture(value: unknown, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-backup-command-"));
  const configPath = join(root, "config.json"); await writeFile(configPath, JSON.stringify(value), { mode });
  return { root, configPath };
}
async function denied(args: string[]) {
  try { await execute(process.execPath, [command, ...args], { timeout: 5000, maxBuffer: 4096 }); }
  catch (failure) {
    const result = failure as { code: number; stdout: string; stderr: string };
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Private backup command failed; check private configuration and retained outputs\n"); return;
  }
  throw new Error("Expected command denial");
}

it("creates an off-host test identity once and prints only its public recipient", async () => {
  const state = await fixture({}); const identityPath = join(state.root, "test-identity");
  await writeFile(state.configPath, JSON.stringify({ action: "keygen", identityPath }));
  const result = await execute(process.execPath, [command, state.configPath], { timeout: 5000, maxBuffer: 4096 });
  const output = JSON.parse(result.stdout) as { action: string; recipient: string };
  expect(output.action).toBe("keygen"); expect(output.recipient).toMatch(/^age1/); expect(result.stderr).toBe("");
  const identity = await readFile(identityPath, "utf8"); expect(identity).toMatch(/^AGE-SECRET-KEY-/);
  expect(result.stdout).not.toContain(identity.trim()); expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
  await denied([state.configPath]); expect(await readFile(identityPath, "utf8")).toBe(identity);
});

it("rejects unsafe config permissions, symlinks, extra arguments and unknown actions without leaking values", async () => {
  const unsafe = await fixture({ action: "unrecognized", privateValue: "Invented secret fixture" }, 0o644);
  await denied([unsafe.configPath]); await denied([unsafe.configPath, "extra"]); await denied([]);
  const invalid = await fixture({ action: "unrecognized", privateValue: "Invented secret fixture" });
  await denied([invalid.configPath]);
  const alias = join(invalid.root, "alias.json"); await symlink(invalid.configPath, alias); await denied([alias]);
});

it("requires stopped-writer attestation and rejects invalid restore pins before touching any database", async () => {
  const state = await fixture({});
  await writeFile(state.configPath, JSON.stringify({ action: "snapshot", sourceDbPath: "/absent/case.sqlite",
    objectRoot: "/absent/objects", recoveryPepperPath: "/absent/pepper", snapshotRoot: "/absent/snapshot",
    encryptedPath: "/absent/backup.age", recipient: "age1inventedinvalidrecipient", writersStopped: false }));
  await denied([state.configPath]);
  await writeFile(state.configPath, JSON.stringify({ action: "restore", expectedSha256: "invalid",
    encryptedPath: "/absent/backup.age", identityPath: "/absent/identity", workRoot: "/absent/work", destinationRoot: "/absent/restored" }));
  await denied([state.configPath]);
});
