import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { ImageDecodeResult, ImageMediaType } from "./imageDecoder.js";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./policy.js";

const MAX_CHILD_REPLY_BYTES = 512;
const rejected = Object.freeze({ verdict: "rejected" as const, code: "MALFORMED" as const });
const resultSchema = z.union([
  z.strictObject({ verdict: z.literal("rejected"), code: z.literal("MALFORMED") }),
  z.strictObject({ verdict: z.literal("safe"), pageCount: z.literal(1),
    frameCount: z.literal(1), width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
    height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION) }),
]);

export type ImageDecodeProcessOptions = Readonly<{
  scriptPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

async function trustedScript(path: string): Promise<boolean> {
  try {
    if (!isAbsolute(path)) return false;
    const stat = await lstat(path);
    return stat.isFile() && (stat.mode & 0o022) === 0 &&
      (process.getuid === undefined || stat.uid === 0 || stat.uid === process.getuid());
  } catch { return false; }
}

/** The server process can SIGKILL a native decode blocked in this child. */
export async function decodeImageInSubprocess(
  input: Uint8Array, mediaType: ImageMediaType, options: ImageDecodeProcessOptions,
): Promise<ImageDecodeResult> {
  if ((mediaType !== "image/png" && mediaType !== "image/jpeg") ||
    input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
    options.timeoutMs > 120_000 || options.signal?.aborted ||
    !await trustedScript(options.scriptPath)) return rejected;
  if (options.signal?.aborted) return rejected;

  const bytes = Buffer.from(input);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [options.scriptPath, mediaType, digest], {
      stdio: ["pipe", "pipe", "ignore"], env: { NODE_ENV: "production" }, shell: false,
      windowsHide: true,
    });
    let output = Buffer.alloc(0);
    let failed = false;
    const kill = () => { failed = true; child.kill("SIGKILL"); };
    const deadline = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > MAX_CHILD_REPLY_BYTES) return kill();
      output = Buffer.concat([output, chunk]);
    });
    child.on("error", () => { failed = true; });
    child.on("close", (code) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", kill);
      if (failed || code !== 0 || output.length < 2) return resolve(rejected);
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
        const parsed = resultSchema.safeParse(value);
        if (!parsed.success || (parsed.data.verdict === "safe" &&
          parsed.data.width * parsed.data.height > MAX_IMAGE_PIXELS)) return resolve(rejected);
        resolve(Object.freeze(parsed.data));
      } catch { resolve(rejected); }
    });
    void (async () => {
      try {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          await new Promise<void>((done, error) => {
            child.stdin.write(chunk, (problem) => problem ? error(problem) : done());
          });
        }
        child.stdin.end();
      } catch { kill(); }
    })();
  });
}
