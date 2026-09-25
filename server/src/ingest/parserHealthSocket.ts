import { chmod, lstat } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { basename, dirname, isAbsolute } from "node:path";

const REQUEST = 0x3f;
const RESPONSE = 0x21;

async function trustedParent(path: string): Promise<boolean> {
  if (!isAbsolute(path) || basename(path) !== "health.sock" ||
    process.getuid === undefined || process.getuid() === 0) return false;
  try {
    const parent = await lstat(dirname(path));
    return parent.isDirectory() && parent.uid === process.getuid() &&
      (parent.mode & 0o027) === 0;
  } catch { return false; }
}

/** Same event loop as the parser, separate from its document request capacity. */
export async function startParserHealthServer(path: string): Promise<Server> {
  if (!await trustedParent(path)) throw new Error("UNSAFE_PARSER_HEALTH_SOCKET");
  process.umask(0o077);
  const server = createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("data", (bytes: Buffer) => {
      if (bytes.length !== 1 || bytes[0] !== REQUEST) return socket.destroy();
      socket.end(Buffer.from([RESPONSE]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  try {
    await chmod(path, 0o600);
    const socket = await lstat(path);
    if (!socket.isSocket() || socket.uid !== process.getuid!() ||
      (socket.mode & 0o777) !== 0o600) throw new Error("UNSAFE_PARSER_HEALTH_SOCKET");
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return server;
}

/** A missed probe never aborts a document decode or terminates the worker. */
export async function checkParserLiveness(path: string): Promise<boolean> {
  if (!await trustedParent(path)) return false;
  try {
    const socket = await lstat(path);
    if (!socket.isSocket() || socket.uid !== process.getuid!() ||
      (socket.mode & 0o777) !== 0o600) return false;
  } catch { return false; }
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    let settled = false;
    let received: number | null = null;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(healthy);
    };
    const deadline = setTimeout(() => finish(false), 5000);
    socket.on("error", () => finish(false));
    socket.on("data", (bytes: Buffer) => {
      if (bytes.length !== 1 || received !== null) return finish(false);
      received = bytes[0]!;
    });
    socket.on("end", () => finish(received === RESPONSE));
    socket.on("close", () => finish(false));
    socket.once("connect", () => socket.end(Buffer.from([REQUEST])));
  });
}
