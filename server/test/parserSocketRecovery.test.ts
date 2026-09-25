import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { archiveStaleParserSocket, ParserSocketRecoveryError } from
  "../src/ingest/parserSocketRecovery.js";
import { checkParserLiveness, startParserHealthServer } from
  "../src/ingest/parserHealthSocket.js";
import { startParserWorkerServer } from "../src/ingest/parserWorker.js";

async function privateSocketPath() {
  return join(await mkdtemp(join(tmpdir(), "adeno-fictional-socket-recovery-")), "parser.sock");
}

describe("recoverable parser socket restart", () => {
  it("archives a worker-owned stale inode after a synthetic SIGKILL, then rebinds", async () => {
    const path = await privateSocketPath();
    const child = spawn(process.execPath, ["-e",
      'process.umask(0o027);require("node:net").createServer().listen(process.argv[1],()=>process.stdout.write("READY"))',
      path], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => reject(new Error("Synthetic listener exited before ready")));
        child.stdout.once("data", () => resolve());
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect((await lstat(path)).isSocket()).toBe(true);
      const recovery = await archiveStaleParserSocket(path);
      expect(recovery.state).toBe("archived");
      if (recovery.state !== "archived") throw new Error("Expected archive");
      expect((await lstat(recovery.archivePath)).isSocket()).toBe(true);
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      const server = await startParserWorkerServer({ socketPath: path });
      try { expect((await lstat(path)).isSocket()).toBe(true); }
      finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    } finally { child.kill("SIGKILL"); }
  });

  it("refuses to move a live socket or a non-socket file", async () => {
    const livePath = await privateSocketPath();
    const live = createServer();
    await new Promise<void>((resolve) => live.listen(livePath, resolve));
    await chmod(livePath, 0o660);
    try {
      await expect(archiveStaleParserSocket(livePath))
        .rejects.toBeInstanceOf(ParserSocketRecoveryError);
      expect((await lstat(livePath)).isSocket()).toBe(true);
    } finally { await new Promise<void>((resolve) => live.close(() => resolve())); }

    const filePath = await privateSocketPath();
    await writeFile(filePath, "fictional marker");
    await expect(archiveStaleParserSocket(filePath))
      .rejects.toBeInstanceOf(ParserSocketRecoveryError);
    expect((await lstat(filePath)).isFile()).toBe(true);
  });

  it("archives and rebinds a stale private health socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adeno-fictional-health-recovery-"));
    const path = join(directory, "health.sock");
    const child = spawn(process.execPath, ["-e",
      'process.umask(0o077);require("node:net").createServer().listen(process.argv[1],()=>process.stdout.write("READY"))',
      path], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => reject(new Error("Synthetic health listener exited early")));
        child.stdout.once("data", () => resolve());
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      const result = await archiveStaleParserSocket(path, "health.sock");
      expect(result.state).toBe("archived");
      if (result.state !== "archived") throw new Error("Expected health socket archive");
      expect((await lstat(result.archivePath)).isSocket()).toBe(true);
      const server = await startParserHealthServer(path);
      try { await expect(checkParserLiveness(path)).resolves.toBe(true); }
      finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    } finally { child.kill("SIGKILL"); }
  });
});
