import { afterEach, expect, it, vi } from "vitest";
import { uploadPrivateImage, UnconfirmedUpload } from "./privateIntake";

afterEach(() => vi.unstubAllGlobals());
const capabilities = { available: true, mediaTypes: ["image/png", "image/jpeg"], maxBytes: 1024 };
const file = new File([Uint8Array.from([0, 1, 255])], "Invented image.png", { type: "image/png" });
const input = { profileId: "profile-a", csrfToken: "fictional-csrf", file, capabilities };

it("sends original file bytes with CSRF and filename headers, without JSON transformation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
    expect(path).toBe("/api/v2/care-profiles/profile-a/documents");
    expect(options.body).toBe(file);
    expect(options.headers).toEqual({ "content-type": "image/png", "x-upload-name": "Invented%20image.png",
      "x-csrf-token": "fictional-csrf" });
    return new Response(JSON.stringify({ documentId: "invented-document", alreadyExisted: false }), { status: 201 });
  }));
  expect(await uploadPrivateImage(input)).toEqual({ documentId: "invented-document", alreadyExisted: false });
});

it("rejects disabled intake, unsupported files and size violations before network access", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(uploadPrivateImage({ ...input, capabilities: { ...capabilities, available: false } })).rejects.toThrow("unavailable");
  await expect(uploadPrivateImage({ ...input, file: new File(["invented"], "invented.pdf", { type: "application/pdf" }) }))
    .rejects.toThrow("not supported");
  await expect(uploadPrivateImage({ ...input, capabilities: { ...capabilities, maxBytes: 1 } })).rejects.toThrow("limit");
  expect(fetcher).not.toHaveBeenCalled();
});

it("reports uncertain outcomes for lost responses and malformed success receipts", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private diagnostic"); }));
  await expect(uploadPrivateImage(input)).rejects.toBeInstanceOf(UnconfirmedUpload);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  await expect(uploadPrivateImage(input)).rejects.toBeInstanceOf(UnconfirmedUpload);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ documentId: 1 }), { status: 201 })));
  await expect(uploadPrivateImage(input)).rejects.toBeInstanceOf(UnconfirmedUpload);
});

it("distinguishes rejected files and busy intake from unconfirmed network results", async () => {
  for (const [status, expected] of [[422, "did not pass inspection"], [429, "Another upload"], [401, "Sign in again"]] as const) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    await expect(uploadPrivateImage(input)).rejects.toThrow(expected);
  }
});
