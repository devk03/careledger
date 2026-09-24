import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { inspectUploadBytes, UploadAdmissionError } from "../src/ingest/admission.js";

const fictionalPdf = Buffer.from("%PDF-1.7\nSYNTHETIC TEST FILE\n%%EOF", "utf8");
const receivedAt = new Date("2030-04-15T10:30:00.000Z");

describe("preliminary upload admission", () => {
  it("keeps upload time separate from care date and fingerprints original bytes", () => {
    const result = inspectUploadBytes(fictionalPdf, {
      originalName: "fictional-record.pdf",
      claimedMediaType: "application/pdf",
      receivedAt,
    });
    expect(result).toEqual({
      displayName: "fictional-record.pdf",
      mediaType: "application/pdf",
      byteSize: fictionalPdf.byteLength,
      sha256: createHash("sha256").update(fictionalPdf).digest("hex"),
      receivedAt: "2030-04-15T10:30:00.000Z",
    });
    expect(fictionalPdf.toString("utf8")).toContain("SYNTHETIC TEST FILE");
  });

  it("accepts only the allowed signature families", () => {
    expect(inspectUploadBytes(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      { originalName: "fictional.png" },
    ).mediaType).toBe("image/png");
    expect(inspectUploadBytes(
      Buffer.from([0xff, 0xd8, 0xff, 0, 0]),
      { originalName: "fictional.jpeg", claimedMediaType: "image/jpg" },
    ).mediaType).toBe("image/jpeg");
    expect(() => inspectUploadBytes(Buffer.from("not a record"), {
      originalName: "fictional.pdf",
    })).toThrowError(new UploadAdmissionError("UNSUPPORTED_TYPE"));
  });

  it("rejects empty and oversized inputs before fingerprinting", () => {
    expect(() => inspectUploadBytes(Buffer.alloc(0), { originalName: "fictional.pdf" }))
      .toThrowError(new UploadAdmissionError("EMPTY_UPLOAD"));
    expect(() => inspectUploadBytes(fictionalPdf, {
      originalName: "fictional.pdf", maxBytes: 4,
    })).toThrowError(new UploadAdmissionError("UPLOAD_TOO_LARGE"));
  });

  it("rejects claimed MIME and extension mismatches", () => {
    expect(() => inspectUploadBytes(fictionalPdf, {
      originalName: "fictional.pdf", claimedMediaType: "image/png",
    })).toThrowError(new UploadAdmissionError("MIME_MISMATCH"));
    expect(() => inspectUploadBytes(fictionalPdf, {
      originalName: "fictional.exe", claimedMediaType: "application/pdf",
    })).toThrowError(new UploadAdmissionError("EXTENSION_MISMATCH"));
  });

  it("normalizes path, control characters, reserved stems and UTF-8 length", () => {
    expect(inspectUploadBytes(fictionalPdf, {
      originalName: "C:\\outside\\CON.pdf\u0000",
    }).displayName).toBe("health-record.pdf");
    const name = inspectUploadBytes(fictionalPdf, {
      originalName: `${"測".repeat(100)}.pdf`,
    }).displayName;
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});
