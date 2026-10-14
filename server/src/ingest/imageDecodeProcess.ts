import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { ImageDecodeResult, ImageMediaType } from "./imageDecoder.js";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./policy.js";
import { MAX_RENDITION_REPLY_BYTES, parseImageRendition, type ImageRenditionResult } from "./imageRenditionProtocol.js";

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

/** Parser-worker use only. A child forked by HTTP/MCP would not create an OS sandbox. */
async function runImageChild(input: Uint8Array, mediaType: ImageMediaType, options: ImageDecodeProcessOptions,
  purpose: "inspect" | "rendition"): Promise<{ value: unknown; sha256: string } | null> {
  if ((mediaType !== "image/png" && mediaType !== "image/jpeg") ||
    input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
    options.timeoutMs > 120_000 || options.signal?.aborted) return null;
  const bytes = Buffer.from(input);
  if (!await trustedScript(options.scriptPath) || options.signal?.aborted) return null;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const maxReplyBytes = purpose === "inspect" ? MAX_CHILD_REPLY_BYTES : MAX_RENDITION_REPLY_BYTES;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [options.scriptPath, mediaType, digest, ...(purpose === "rendition" ? [purpose] : [])], {
      stdio: ["pipe", "pipe", "ignore"], env: { NODE_ENV: "production" }, shell: false,
      windowsHide: true,
    });
    const chunks: Buffer[] = []; let total = 0;
    let failed = false;
    const kill = () => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
    };
    const deadline = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stdin.on("error", kill);
    child.stdout.on("error", kill);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxReplyBytes) return kill();
      chunks.push(chunk);
    });
    child.on("error", () => { failed = true; });
    child.on("close", (code) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", kill);
      if (failed || code !== 0 || total < 2) return resolve(null);
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
        resolve({ value, sha256: digest });
      } catch { resolve(null); }
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

export async function decodeImageInSubprocess(input: Uint8Array, mediaType: ImageMediaType,
  options: ImageDecodeProcessOptions): Promise<ImageDecodeResult> {
  const result = await runImageChild(input, mediaType, options, "inspect");
  if (!result) return rejected;
  const parsed = resultSchema.safeParse(result.value);
  if (!parsed.success || (parsed.data.verdict === "safe" && parsed.data.width * parsed.data.height > MAX_IMAGE_PIXELS)) return rejected;
  return Object.freeze(parsed.data);
}

export async function renderImageInSubprocess(input: Uint8Array, mediaType: ImageMediaType,
  options: ImageDecodeProcessOptions): Promise<ImageRenditionResult> {
  const result = await runImageChild(input, mediaType, options, "rendition");
  return result ? parseImageRendition(result.value, result.sha256) : rejected;
}
