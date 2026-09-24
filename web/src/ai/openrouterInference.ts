const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 8;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const APPROVAL_TTL_MS = 5 * 60 * 1000;

export type SupportedPageType = "image/jpeg" | "image/png";

export interface ManagedInferenceContract {
  model: string;
  instructions: string;
  strictFormat: Record<string, unknown>;
}

export interface ApprovedPageArtifact {
  bytes: Uint8Array;
  mediaType: SupportedPageType;
  originalPageNumber: number;
  artifactSha256: string;
}

export interface ApprovedInferenceSource {
  pages: ApprovedPageArtifact[];
  batchToken: string;
  safetyIdentifier: string;
}

export interface InferenceApprovalReceipt {
  readonly batchToken: string;
  readonly expiresAt: number;
  readonly pageNumbers: readonly number[];
  readonly pageDigests: readonly string[];
  readonly requestFingerprint: string;
}

export interface ManagedInferenceResult {
  response: unknown;
  cost: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export class ManagedInferenceError extends Error {
  constructor() {
    super("adeno could not complete this explanation. Your original is still safe.");
    this.name = "ManagedInferenceError";
  }
}

const issuedApprovals = new WeakSet<InferenceApprovalReceipt>();
const consumedApprovals = new WeakSet<InferenceApprovalReceipt>();

const PROVIDER_POLICY = Object.freeze({
  zdr: true,
  data_collection: "deny",
  require_parameters: true,
  allow_fallbacks: false,
});

export async function approveInferenceTransfer(
  contract: ManagedInferenceContract,
  source: ApprovedInferenceSource,
  displayedCostBand: string,
): Promise<InferenceApprovalReceipt> {
  assertContract(contract);
  assertSourceShape(source);
  assertCostBand(displayedCostBand);
  const pageDigests = await verifiedPageDigests(source.pages);
  const requestFingerprint = await transferFingerprint(
    contract,
    source,
    displayedCostBand,
  );
  const receipt = Object.freeze({
    batchToken: source.batchToken,
    expiresAt: Date.now() + APPROVAL_TTL_MS,
    pageNumbers: Object.freeze(source.pages.map((page) => page.originalPageNumber)),
    pageDigests: Object.freeze(pageDigests),
    requestFingerprint,
  });
  issuedApprovals.add(receipt);
  return receipt;
}

export async function sendApprovedRecordToOpenRouter(
  credentialBytes: Uint8Array,
  contract: ManagedInferenceContract,
  source: ApprovedInferenceSource,
  approval: InferenceApprovalReceipt,
  displayedCostBand: string,
): Promise<ManagedInferenceResult> {
  try {
    const credential = new TextDecoder("utf-8", { fatal: true }).decode(credentialBytes);
    if (
      !credential.startsWith("sk-or-") ||
      credential.length < 20 ||
      credential.length > 512 ||
      /\s/u.test(credential)
    ) {
      throw new ManagedInferenceError();
    }
    const request = await buildPatientDataRequest(
      contract,
      source,
      approval,
      displayedCostBand,
    );
    const response = await fetch(OPENROUTER_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Cache": "false",
      },
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ManagedInferenceError();
    }
    const parsed: unknown = JSON.parse(await boundedResponseText(response));
    return safeResult(parsed);
  } catch (error) {
    if (error instanceof ManagedInferenceError) throw error;
    throw new ManagedInferenceError();
  } finally {
    // This reduces the lifetime of this byte-array copy. JavaScript strings and browser-managed
    // request-header copies cannot be deterministically erased.
    credentialBytes.fill(0);
  }
}

export async function buildPatientDataRequest(
  contract: ManagedInferenceContract,
  source: ApprovedInferenceSource,
  approval: InferenceApprovalReceipt,
  displayedCostBand: string,
): Promise<Record<string, unknown>> {
  assertContract(contract);
  assertCostBand(displayedCostBand);
  await consumeApproval(contract, source, approval, displayedCostBand);
  const manifest = JSON.stringify({
    batch_token: source.batchToken,
    original_page_numbers: source.pages.map((page) => page.originalPageNumber),
  });
  const content: Record<string, unknown>[] = [
    { type: "input_text", text: `Trusted page mapping: ${manifest}` },
    ...source.pages.map((page) => ({
      type: "input_image",
      detail: "high",
      image_url: `data:${page.mediaType};base64,${bytesToBase64(page.bytes)}`,
    })),
  ];

  const request: Record<string, unknown> = {
    model: contract.model,
    store: false,
    background: false,
    stream: false,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    truncation: "disabled",
    instructions: contract.instructions,
    safety_identifier: source.safetyIdentifier,
    max_output_tokens: 12_000,
    input: [{ role: "user", content }],
    text: { format: contract.strictFormat },
    provider: PROVIDER_POLICY,
    plugins: [{ id: "web", enabled: false }],
  };
  assertPatientDataRequest(request);
  return request;
}

async function consumeApproval(
  contract: ManagedInferenceContract,
  source: ApprovedInferenceSource,
  approval: InferenceApprovalReceipt,
  displayedCostBand: string,
): Promise<void> {
  assertSourceShape(source);
  if (
    !issuedApprovals.has(approval) ||
    consumedApprovals.has(approval) ||
    Date.now() >= approval.expiresAt ||
    approval.batchToken !== source.batchToken ||
    approval.pageNumbers.length !== source.pages.length ||
    approval.pageDigests.length !== source.pages.length
  ) {
    throw new ManagedInferenceError();
  }
  const digests = await verifiedPageDigests(source.pages);
  const fingerprint = await transferFingerprint(contract, source, displayedCostBand);
  if (approval.requestFingerprint !== fingerprint) throw new ManagedInferenceError();
  for (const [index, page] of source.pages.entries()) {
    if (
      approval.pageNumbers[index] !== page.originalPageNumber ||
      approval.pageDigests[index] !== digests[index]
    ) {
      throw new ManagedInferenceError();
    }
  }
  consumedApprovals.add(approval);
}

async function transferFingerprint(
  contract: ManagedInferenceContract,
  source: ApprovedInferenceSource,
  displayedCostBand: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    canonicalJson({
      version: "careledger.transfer-approval.v1",
      batchToken: source.batchToken,
      safetyIdentifier: source.safetyIdentifier,
      model: contract.model,
      instructions: contract.instructions,
      strictFormat: contract.strictFormat,
      provider: PROVIDER_POLICY,
      plugins: [{ id: "web", enabled: false }],
      displayedCostBand,
      pages: source.pages.map((page) => ({
        artifactSha256: page.artifactSha256,
        mediaType: page.mediaType,
        originalPageNumber: page.originalPageNumber,
      })),
    }),
  );
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)));
}

async function verifiedPageDigests(pages: ApprovedPageArtifact[]): Promise<string[]> {
  const digests: string[] = [];
  for (const page of pages) {
    const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", page.bytes)));
    if (digest !== page.artifactSha256) throw new ManagedInferenceError();
    digests.push(digest);
  }
  return digests;
}

function assertContract(contract: ManagedInferenceContract): void {
  if (
    !contract.model ||
    contract.model.length > 200 ||
    contract.model.toLowerCase().includes(":online") ||
    !contract.instructions ||
    contract.instructions.length > 20_000 ||
    contract.strictFormat.type !== "json_schema" ||
    contract.strictFormat.strict !== true ||
    typeof contract.strictFormat.name !== "string" ||
    typeof contract.strictFormat.schema !== "object" ||
    contract.strictFormat.schema === null
  ) {
    throw new ManagedInferenceError();
  }
}

function assertCostBand(value: string): void {
  if (!value.trim() || value.length > 120) throw new ManagedInferenceError();
}

function assertSourceShape(source: ApprovedInferenceSource): void {
  const totalBytes = source.pages.reduce((sum, page) => sum + page.bytes.byteLength, 0);
  if (
    source.pages.length < 1 ||
    source.pages.length > MAX_PAGES ||
    totalBytes > MAX_TOTAL_BYTES ||
    !source.batchToken ||
    source.batchToken.length > 256 ||
    !/^[0-9a-f]{64}$/u.test(source.safetyIdentifier) ||
    new Set(source.pages.map((page) => page.originalPageNumber)).size !== source.pages.length
  ) {
    throw new ManagedInferenceError();
  }
  for (const page of source.pages) {
    if (
      page.bytes.byteLength < 1 ||
      page.bytes.byteLength > MAX_PAGE_BYTES ||
      !["image/jpeg", "image/png"].includes(page.mediaType) ||
      !Number.isSafeInteger(page.originalPageNumber) ||
      page.originalPageNumber < 1 ||
      page.originalPageNumber > 10_000 ||
      !/^[0-9a-f]{64}$/u.test(page.artifactSha256)
    ) {
      throw new ManagedInferenceError();
    }
  }
}

function assertPatientDataRequest(request: Record<string, unknown>): void {
  if (
    request.store !== false ||
    request.background !== false ||
    request.stream !== false ||
    !Array.isArray(request.tools) ||
    request.tools.length !== 0 ||
    request.tool_choice !== "none" ||
    request.parallel_tool_calls !== false ||
    JSON.stringify(request.provider) !==
      JSON.stringify({
        zdr: true,
        data_collection: "deny",
        require_parameters: true,
        allow_fallbacks: false,
      }) ||
    JSON.stringify(request.plugins) !== JSON.stringify([{ id: "web", enabled: false }])
  ) {
    throw new ManagedInferenceError();
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredHeader = response.headers.get("Content-Length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isFinite(declared) || declared > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new ManagedInferenceError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ManagedInferenceError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function safeResult(value: unknown): ManagedInferenceResult {
  if (!isObject(value)) throw new ManagedInferenceError();
  const usage = isObject(value.usage) ? value.usage : {};
  return {
    response: value,
    cost: safeNonnegativeDecimal(usage.cost),
    inputTokens: safeNonnegativeInteger(usage.input_tokens),
    outputTokens: safeNonnegativeInteger(usage.output_tokens),
  };
}

function safeNonnegativeDecimal(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return String(value);
}

function safeNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function bytesToBase64(value: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let start = 0; start < value.length; start += chunkSize) {
    binary += String.fromCharCode(...value.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ManagedInferenceError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new ManagedInferenceError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
