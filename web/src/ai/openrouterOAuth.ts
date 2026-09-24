const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const PENDING_PREFIX = "careledger:openrouter-pkce:";
const FLOW_TTL_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();

interface PendingAuthorization {
  callbackUrl: string;
  codeVerifier: string;
  createdAt: number;
}

export interface OpenRouterBrowserCredential {
  keyBytes: Uint8Array;
  providerUserId: string | null;
}

export class OpenRouterOAuthError extends Error {
  constructor() {
    super("adeno could not securely connect explanations. Please try again.");
    this.name = "OpenRouterOAuthError";
  }
}

export async function beginOpenRouterAuthorization(publicBaseUrl: string): Promise<string> {
  const origin = validatedOrigin(publicBaseUrl);
  const flowToken = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier))),
  );
  const callbackUrl = `${origin}/openrouter/callback/${flowToken}`;
  const pending: PendingAuthorization = {
    callbackUrl,
    codeVerifier,
    createdAt: Date.now(),
  };
  sessionStorage.setItem(`${PENDING_PREFIX}${flowToken}`, JSON.stringify(pending));

  const authorization = new URL(OPENROUTER_AUTH_URL);
  authorization.searchParams.set("callback_url", callbackUrl);
  authorization.searchParams.set("code_challenge", codeChallenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  return authorization.toString();
}

export async function completeOpenRouterAuthorization(
  currentUrl: string,
): Promise<OpenRouterBrowserCredential> {
  try {
    const callback = new URL(currentUrl);
    const match = callback.pathname.match(
      /^\/openrouter\/callback\/([A-Za-z0-9_-]{43})$/u,
    );
    const code = callback.searchParams.get("code");
    if (!match || !code || !/^[A-Za-z0-9._~-]{1,512}$/u.test(code)) {
      throw new OpenRouterOAuthError();
    }

    const flowToken = match[1];
    const storageKey = `${PENDING_PREFIX}${flowToken}`;
    const serialized = sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    history.replaceState(null, "", "/?ai=connecting");
    if (!serialized) throw new OpenRouterOAuthError();

    const pending = parsePendingAuthorization(serialized);
    const cleanCallback = `${callback.origin}${callback.pathname}`;
    if (
      pending.callbackUrl !== cleanCallback ||
      Date.now() < pending.createdAt ||
      Date.now() - pending.createdAt >= FLOW_TTL_MS
    ) {
      throw new OpenRouterOAuthError();
    }

    const response = await fetch(OPENROUTER_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pending.codeVerifier,
        code_challenge_method: "S256",
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new OpenRouterOAuthError();
    const payload: unknown = await response.json();
    return parseCredential(payload);
  } catch (error) {
    if (error instanceof OpenRouterOAuthError) throw error;
    throw new OpenRouterOAuthError();
  }
}

function parsePendingAuthorization(value: string): PendingAuthorization {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) throw new OpenRouterOAuthError();
  const callbackUrl = parsed.callbackUrl;
  const codeVerifier = parsed.codeVerifier;
  const createdAt = parsed.createdAt;
  if (
    typeof callbackUrl !== "string" ||
    typeof codeVerifier !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/u.test(codeVerifier) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt)
  ) {
    throw new OpenRouterOAuthError();
  }
  return { callbackUrl, codeVerifier, createdAt };
}

function parseCredential(value: unknown): OpenRouterBrowserCredential {
  if (!isObject(value)) throw new OpenRouterOAuthError();
  const key = value.key;
  const userId = value.user_id;
  if (
    typeof key !== "string" ||
    !key.startsWith("sk-or-") ||
    key.length < 20 ||
    key.length > 512 ||
    /\s/u.test(key) ||
    (userId !== null &&
      userId !== undefined &&
      (typeof userId !== "string" || !/^[A-Za-z0-9._~-]{1,256}$/u.test(userId)))
  ) {
    throw new OpenRouterOAuthError();
  }
  return {
    keyBytes: encoder.encode(key),
    providerUserId: typeof userId === "string" ? userId : null,
  };
}

function validatedOrigin(value: string): string {
  const parsed = new URL(value);
  const localHttp =
    parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new OpenRouterOAuthError();
  }
  return parsed.origin;
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
