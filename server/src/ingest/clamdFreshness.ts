import { createConnection } from "node:net";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_REPLY_BYTES = 1024;
export const MAX_SIGNATURE_AGE_SECONDS = 48 * 60 * 60;

/** ClamD uses ctime formatting; the isolated daemon must run with TZ=UTC. */
function signatureTimestamp(value: string): number | null {
  const match = /^ClamAV \d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?\/[1-9]\d{0,9}\/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  if (!match) return null;
  const [, weekday, month, day, hour, minute, second, year] = match;
  const date = new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hour), Number(minute), Number(second)));
  if (Number(year) < 2020 || date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== MONTHS.indexOf(month!) || date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second) || DAYS[date.getUTCDay()] !== weekday) return null;
  return date.getTime();
}

export function signatureIsFresh(timestampMs: number, maxAgeSeconds: number, nowMs = Date.now()): boolean {
  return Number.isFinite(timestampMs) && Number.isFinite(nowMs) &&
    timestampMs <= nowMs + 5 * 60 * 1000 && nowMs - timestampMs <= maxAgeSeconds * 1000;
}

/** Bounded control request. It sends no document bytes and caches no approval. */
export async function readFreshSignatureTimestamp(input: {
  socketPath: string; timeoutMs: number; maxAgeSeconds: number;
}): Promise<number | null> {
  return await new Promise(resolve => {
    const socket = createConnection({ path: input.socketPath });
    let settled = false; let sent = false; let reply = Buffer.alloc(0);
    const finish = (timestamp: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); socket.destroy(); resolve(timestamp);
    };
    const deadline = setTimeout(() => finish(null), Math.min(input.timeoutMs, 5000));
    socket.on("error", () => finish(null)); socket.on("end", () => finish(null));
    socket.once("connect", () => {
      socket.write(Buffer.from("zVERSION\0", "ascii"), error => {
        if (error) finish(null); else sent = true;
      });
    });
    socket.on("data", (chunk: Buffer) => {
      if (!sent || reply.length + chunk.length > MAX_REPLY_BYTES) return finish(null);
      reply = Buffer.concat([reply, chunk]);
      const terminator = reply.indexOf(0);
      if (terminator === -1) return;
      if (terminator !== reply.length - 1) return finish(null);
      const timestamp = signatureTimestamp(reply.subarray(0, terminator).toString("utf8"));
      finish(timestamp !== null && signatureIsFresh(timestamp, input.maxAgeSeconds) ? timestamp : null);
    });
  });
}
