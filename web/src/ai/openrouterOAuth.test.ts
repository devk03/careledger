import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OpenRouterOAuthError,
  beginOpenRouterAuthorization,
  completeOpenRouterAuthorization,
} from "./openrouterOAuth";

describe("browser-only OpenRouter connection", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("creates an S256 flow without exposing the verifier in the URL", async () => {
    const authorizationUrl = await beginOpenRouterAuthorization("https://care.example.test");
    const authorization = new URL(authorizationUrl);

    expect(authorization.origin).toBe("https://openrouter.ai");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authorization.searchParams.get("callback_url")).toMatch(
      /^https:\/\/care\.example\.test\/openrouter\/callback\/[A-Za-z0-9_-]{43}$/u,
    );
    expect(authorizationUrl).not.toContain("code_verifier");
  });

  it("exchanges once from the browser and returns key bytes for immediate vault encryption", async () => {
    const authorizationUrl = await beginOpenRouterAuthorization("https://care.example.test");
    const callback = new URL(new URL(authorizationUrl).searchParams.get("callback_url") ?? "");
    callback.searchParams.set("code", "synthetic-code_123");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          key: "sk-or-v1-synthetic-browser-key",
          user_id: "synthetic-user",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connected = await completeOpenRouterAuthorization(callback.toString());
    expect(new TextDecoder().decode(connected.keyBytes)).toBe(
      "sk-or-v1-synthetic-browser-key",
    );
    expect(connected.providerUserId).toBe("synthetic-user");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain("care.example.test");

    await expect(completeOpenRouterAuthorization(callback.toString())).rejects.toBeInstanceOf(
      OpenRouterOAuthError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("expires pending authorization after ten minutes without contacting OpenRouter", async () => {
    const authorizationUrl = await beginOpenRouterAuthorization("https://care.example.test");
    const callback = new URL(new URL(authorizationUrl).searchParams.get("callback_url") ?? "");
    callback.searchParams.set("code", "synthetic-code_123");
    vi.advanceTimersByTime(10 * 60 * 1000);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeOpenRouterAuthorization(callback.toString())).rejects.toBeInstanceOf(
      OpenRouterOAuthError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects public HTTP callbacks before storing any secret", async () => {
    await expect(beginOpenRouterAuthorization("http://care.example.test")).rejects.toBeInstanceOf(
      OpenRouterOAuthError,
    );
    expect(sessionStorage).toHaveLength(0);
  });
});
