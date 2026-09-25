import { spawn, spawnSync } from "node:child_process";
import { fstatSync, readSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { AnonymousInputUnavailable, withLinuxAnonymousSeekableInput } from
  "../src/ingest/linuxAnonymousInput.js";

const isLinuxTmpfs = process.platform === "linux" && process.getuid?.() !== 0 &&
  ["x64", "arm64"].includes(process.arch) &&
  (await statfs("/tmp").catch(() => null))?.type === 0x01021994;

describe("synthetic unnamed Linux input", () => {
  it("fails closed outside the supported tmpfs boundary", async () => {
    if (isLinuxTmpfs) return;
    await expect(withLinuxAnonymousSeekableInput(Buffer.from("FICTIONAL"), async () => null))
      .rejects.toBeInstanceOf(AnonymousInputUnavailable);
  });

  it.skipIf(!isLinuxTmpfs)("passes only an unnamed seekable descriptor to a child", async () => {
    const input = Buffer.from("FICTIONAL");
    const output = await withLinuxAnonymousSeekableInput(input, async (fd) => {
      expect(fstatSync(fd).nlink).toBe(0);
      return new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e",
          'const fs=require("node:fs");const fd=fs.openSync("/proc/self/fd/3","r");const b=Buffer.alloc(9);fs.readSync(fd,b,0,9,0);process.stdout.write(b.toString())'], {
          stdio: ["ignore", "pipe", "ignore", fd], env: { NODE_ENV: "production" },
        });
        let result = "";
        if (!child.stdout) return reject(new Error("CHILD_STDOUT_UNAVAILABLE"));
        child.stdout.on("data", (part: Buffer) => { result += part.toString("utf8"); });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(result) : reject(new Error("CHILD_FAILED")));
      });
    });
    expect(output).toBe("FICTIONAL");
  });

  it.skipIf(!isLinuxTmpfs)("closes the descriptor when the callback rejects", async () => {
    let descriptor = -1;
    await expect(withLinuxAnonymousSeekableInput(Buffer.from("FICTIONAL"), async (fd) => {
      descriptor = fd;
      expect(fstatSync(fd).nlink).toBe(0);
      throw new Error("SYNTHETIC_CALLBACK_FAILURE");
    })).rejects.toThrow("SYNTHETIC_CALLBACK_FAILURE");
    expect(() => fstatSync(descriptor)).toThrow();
  });

  it.skipIf(!isLinuxTmpfs)("documents same-UID mutation despite a read-only fd", async () => {
    await withLinuxAnonymousSeekableInput(Buffer.from("FICTIONAL"), async (fd) => {
      expect(fstatSync(fd).nlink).toBe(0);
      const child = spawnSync(process.execPath, ["-e",
        'const fs=require("node:fs");const fd=fs.openSync("/proc/self/fd/3","r+");fs.writeSync(fd,Buffer.from("M"),0,1,0)'], {
        stdio: ["ignore", "ignore", "ignore", fd], env: { NODE_ENV: "production" },
      });
      expect(child.status).toBe(0);
      const observed = Buffer.alloc(9);
      readSync(fd, observed, 0, observed.length, 0);
      expect(observed.toString()).toBe("MICTIONAL");
    });
  });
});
