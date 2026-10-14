import { isAbsolute } from "node:path";

/** Explicit opt-in to server-readable private storage, never managed E2EE. */
export function privatePilotConfig(env: NodeJS.ProcessEnv) {
  const origin = env.ADENO_PRIVATE_ORIGIN;
  const databasePath = env.ADENO_PRIVATE_DB_PATH;
  const secretsDirectory = env.ADENO_PRIVATE_SECRETS_DIR;
  const webRoot = env.ADENO_PRIVATE_WEB_ROOT;
  const portText = env.PORT ?? "8080";
  const port = Number(portText);
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
  return { origin, databasePath, secretsDirectory, webRoot, port };
}
