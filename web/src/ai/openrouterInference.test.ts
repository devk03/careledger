import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  ManagedInferenceError,
  approveInferenceTransfer,
  buildPatientDataRequest,
  sendApprovedRecordToOpenRouter,
} from "./openrouterInference";

const contract = {
  model: "openai/synthetic-model",
  instructions: "Extract only explicit synthetic facts and return the strict schema.",
  strictFormat: {
    type: "json_schema",
    name: "synthetic_contract",
    strict: true,
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};
const costBand = "Usually under $0.05";

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function source() {
  const bytes = new TextEncoder().encode("SYNTHETIC RENDERED PAGE — NOT A REAL PATIENT");
  return {
    pages: [
      {
        bytes,
        mediaType: "image/png" as const,
        originalPageNumber: 1,
        artifactSha256: await digest(bytes),
      },
    ],
    batchToken: "synthetic-batch",
    safetyIdentifier: "a".repeat(64),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("builds a direct, tool-free, no-fallback, ZDR patient request", async () => {
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);
  const request = await buildPatientDataRequest(
    contract,
    approvedSource,
    approval,
    costBand,
  );
  expect(request).toMatchObject({
    model: "openai/synthetic-model",
    store: false,
    background: false,
    stream: false,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    provider: {
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
      allow_fallbacks: false,
    },
    plugins: [{ id: "web", enabled: false }],
  });
  expect(JSON.stringify(request)).not.toContain("filename.pdf");
  expect(JSON.stringify(request)).not.toContain("input_file");
});

it("calls OpenRouter directly, reports usage, and reduces one key copy lifetime", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "synthetic-response",
        usage: { input_tokens: 12, output_tokens: 7, cost: 0.00125 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const keyBytes = new TextEncoder().encode("sk-or-v1-synthetic-browser-key");
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);

  const result = await sendApprovedRecordToOpenRouter(
    keyBytes,
    contract,
    approvedSource,
    approval,
    costBand,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/responses");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
    "X-OpenRouter-Cache": "false",
  });
  expect(result).toMatchObject({ cost: "0.00125", inputTokens: 12, outputTokens: 7 });
  expect(keyBytes.every((byte) => byte === 0)).toBe(true);
});

it("rejects a full PDF paired with a subset page claim before network access", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7 synthetic whole document");
  const invalidSource = {
    pages: [
      {
        bytes,
        mediaType: "application/pdf" as never,
        originalPageNumber: 1,
        artifactSha256: await digest(bytes),
      },
    ],
    batchToken: "synthetic-batch",
    safetyIdentifier: "a".repeat(64),
  };
  await expect(
    approveInferenceTransfer(contract, invalidSource, costBand),
  ).rejects.toBeInstanceOf(ManagedInferenceError);
});

it("rejects changed or replayed approval receipts", async () => {
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);
  await buildPatientDataRequest(contract, approvedSource, approval, costBand);
  await expect(
    buildPatientDataRequest(contract, approvedSource, approval, costBand),
  ).rejects.toBeInstanceOf(ManagedInferenceError);

  const freshSource = await source();
  const freshApproval = await approveInferenceTransfer(contract, freshSource, costBand);
  freshSource.pages[0].bytes[0] ^= 1;
  await expect(
    buildPatientDataRequest(contract, freshSource, freshApproval, costBand),
  ).rejects.toBeInstanceOf(ManagedInferenceError);
});

it("expires approval before any patient bytes leave the browser", async () => {
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);
  vi.advanceTimersByTime(5 * 60 * 1000);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const keyBytes = new TextEncoder().encode("sk-or-v1-synthetic-browser-key");

  await expect(
    sendApprovedRecordToOpenRouter(
      keyBytes,
      contract,
      approvedSource,
      approval,
      costBand,
    ),
  ).rejects.toBeInstanceOf(ManagedInferenceError);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("never retries a provider failure and does not read its body", async () => {
  const cancel = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, body: { cancel } });
  vi.stubGlobal("fetch", fetchMock);
  const keyBytes = new TextEncoder().encode("sk-or-v1-synthetic-browser-key");
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);

  await expect(
    sendApprovedRecordToOpenRouter(
      keyBytes,
      contract,
      approvedSource,
      approval,
      costBand,
    ),
  ).rejects.toBeInstanceOf(ManagedInferenceError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("rejects online models before any patient bytes leave the browser", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const keyBytes = new TextEncoder().encode("sk-or-v1-synthetic-browser-key");
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);

  await expect(
    sendApprovedRecordToOpenRouter(
      keyBytes,
      { ...contract, model: "openai/synthetic-model:online" },
      approvedSource,
      approval,
      costBand,
    ),
  ).rejects.toBeInstanceOf(ManagedInferenceError);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("invalidates approval when the model, schema, media type, or shown cost changes", async () => {
  const approvedSource = await source();
  const approval = await approveInferenceTransfer(contract, approvedSource, costBand);
  await expect(
    buildPatientDataRequest(
      { ...contract, model: "openai/changed-model" },
      approvedSource,
      approval,
      costBand,
    ),
  ).rejects.toBeInstanceOf(ManagedInferenceError);

  const anotherSource = await source();
  const anotherApproval = await approveInferenceTransfer(contract, anotherSource, costBand);
  await expect(
    buildPatientDataRequest(contract, anotherSource, anotherApproval, "A different price"),
  ).rejects.toBeInstanceOf(ManagedInferenceError);
});
