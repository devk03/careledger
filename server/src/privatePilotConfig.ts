import { dirname, isAbsolute, join } from "node:path";

/** Explicit opt-in to server-readable private storage, never managed E2EE. */
export function privatePilotConfig(env: NodeJS.ProcessEnv) {
  const origin = env.ADENO_PRIVATE_ORIGIN;
  const databasePath = env.ADENO_PRIVATE_DB_PATH;
  const secretsDirectory = env.ADENO_PRIVATE_SECRETS_DIR;
  const webRoot = env.ADENO_PRIVATE_WEB_ROOT;
  const portText = env.PORT ?? "8080";
  const port = Number(portText);
  if (![undefined, "disabled", "verified"].includes(env.ADENO_PRIVATE_AGENT_CONNECTIONS))
    throw new Error("Private agent connection configuration is invalid");
  if (![undefined, "disabled", "verified"].includes(env.ADENO_PRIVATE_RECORDS))
    throw new Error("Private record configuration is invalid");
  if (env.ADENO_EDITION !== "trusted-private" || !origin || !databasePath ||
    !secretsDirectory || !webRoot || ![databasePath, secretsDirectory, webRoot].every(isAbsolute) ||
    !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Private pilot configuration is missing or invalid");
  }
  let url: URL;
  try { url = new URL(origin); }
  catch { throw new Error("Private pilot origin is invalid"); }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Private pilot requires an exact public HTTPS origin");
  }
  let records: { objectRoot: string; quarantineRoot: string; parserSocket: string;
    scannerSocket: string; maxStorageBytes: number } | null = null;
  if (env.ADENO_PRIVATE_RECORDS === "verified") {
    const parserSocket = env.ADENO_PRIVATE_PARSER_SOCKET;
    const scannerSocket = env.ADENO_PRIVATE_SCANNER_SOCKET;
    const storageText = env.ADENO_PRIVATE_STORAGE_BYTES ?? "536870912";
    const maxStorageBytes = Number(storageText);
    if (!parserSocket || !scannerSocket || ![parserSocket, scannerSocket].every(isAbsolute) ||
      parserSocket === scannerSocket || !/^\d+$/.test(storageText) || !Number.isSafeInteger(maxStorageBytes) ||
      maxStorageBytes < 64 * 1024 * 1024 || maxStorageBytes > 512 * 1024 * 1024)
      throw new Error("Private record adapter configuration is invalid");
    records = { objectRoot: join(dirname(databasePath), "objects"), quarantineRoot: join(dirname(databasePath), "quarantine"),
      parserSocket, scannerSocket, maxStorageBytes };
  }
  return { origin, databasePath, secretsDirectory, webRoot, port, records,
    agentConnectionsAvailable: env.ADENO_PRIVATE_AGENT_CONNECTIONS === "verified" };
}
