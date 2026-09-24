import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TTL_SECONDS = 60 * 60;

/** Private, one-time local setup secret. Never put the token in source or env files. */
export class BootstrapTokenStore {
  private readonly tokenPath: string;
  private readonly hashPath: string;
  private readonly completedPath: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("Bootstrap directory must be absolute");
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) ||
        error.code !== "EEXIST") throw error;
    }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Bootstrap directory must be private");
    this.tokenPath = join(directory, "bootstrap-token");
    this.hashPath = join(directory, "bootstrap-token.sha256");
    this.completedPath = join(directory, "bootstrap.completed");
  }

  initialize(nowSeconds = Math.floor(Date.now() / 1000)): string | null {
    if (this.fileInfo(this.completedPath)) return null;
    const tokenInfo = this.fileInfo(this.tokenPath);
    const hashInfo = this.fileInfo(this.hashPath);
    if (tokenInfo !== null || hashInfo !== null) {
      if (!tokenInfo || !hashInfo || Number(tokenInfo.mtimeMs) / 1000 + TTL_SECONDS <= nowSeconds)
        throw new Error("Bootstrap secret is incomplete or expired; operator rotation is required");
      const token = readFileSync(this.tokenPath, "utf8").trim();
      if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid bootstrap token file");
      return token;
    }
    const token = randomBytes(32).toString("base64url");
    const sha256 = createHash("sha256").update(token).digest("hex");
    writeFileSync(this.tokenPath, token, { flag: "wx", mode: 0o600 });
    writeFileSync(this.hashPath, sha256, { flag: "wx", mode: 0o600 });
    return token;
  }

  verify(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    if (!TOKEN_PATTERN.test(token) || this.fileInfo(this.completedPath)) return false;
    const tokenInfo = this.fileInfo(this.tokenPath);
    if (!tokenInfo || Number(tokenInfo.mtimeMs) / 1000 + TTL_SECONDS <= nowSeconds ||
      !this.fileInfo(this.hashPath)) return false;
    const expected = readFileSync(this.hashPath, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(expected)) return false;
    const actual = createHash("sha256").update(token).digest();
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
  }

  complete(): void {
    writeFileSync(this.completedPath, new Date().toISOString(), { flag: "wx", mode: 0o600 });
  }

  private fileInfo(path: string): ReturnType<typeof lstatSync> | null {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error("Bootstrap file must be private");
      return info;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
}
