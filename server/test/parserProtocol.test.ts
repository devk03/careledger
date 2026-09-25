import { describe, expect, it } from "vitest";

import { createParserRequest, encodeParserRequestHeader,
  MAX_PARSER_REPLY_BYTES, PARSER_WORKER_VERSION, parseParserReply, parseParserRequestHeader,
  ParserProtocolError } from "../src/ingest/parserProtocol.js";

const digest = "a".repeat(64);

function body(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), "utf8"); }

describe("bounded parser-worker protocol", () => {
  it("frames a versioned request with no filename or clinical text", () => {
    const request = createParserRequest({
      mediaType: "application/pdf", sha256: digest, byteSize: 123,
    });
    const frame = encodeParserRequestHeader(request);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(parseParserRequestHeader(frame.subarray(4))).toEqual(request);
    expect(Object.keys(request).sort()).toEqual([
      "byteSize", "mediaType", "policyVersion", "protocolVersion", "requestId", "sha256",
    ]);
  });

  it("accepts only bounded PDF metadata bound to the same request", () => {
    const request = createParserRequest({
      mediaType: "application/pdf", sha256: digest, byteSize: 123,
    });
    const valid = { ...request, workerVersion: PARSER_WORKER_VERSION, verdict: "safe",
      pageCount: 2, objectCount: 12, maxPageWidthPoints: 612,
      maxPageHeightPoints: 792, encrypted: false, activeContent: false };
    expect(parseParserReply(body(valid), request)).toEqual(valid);
    for (const changed of [
      { ...valid, sha256: "b".repeat(64) },
      { ...valid, pageCount: 201 },
      { ...valid, objectCount: 100_001 },
      { ...valid, maxPageWidthPoints: 14_401 },
      { ...valid, activeContent: true },
      { ...valid, workerVersion: "other-parser" },
      { ...valid, extractedText: "must never enter the protocol" },
    ]) expect(() => parseParserReply(body(changed), request)).toThrow(ParserProtocolError);
  });

  it("rejects unsafe image dimensions and accepts a bounded rejection code", () => {
    const request = createParserRequest({
      mediaType: "image/png", sha256: digest, byteSize: 123,
    });
    const valid = { ...request, workerVersion: PARSER_WORKER_VERSION, verdict: "safe",
      pageCount: 1, frameCount: 1, width: 1000, height: 2000 };
    expect(parseParserReply(body(valid), request)).toEqual(valid);
    for (const changed of [
      { ...valid, width: 10_000, height: 10_000 },
      { ...valid, frameCount: 2 },
      { ...valid, mediaType: "image/jpeg" },
    ]) expect(() => parseParserReply(body(changed), request)).toThrow(ParserProtocolError);
    const rejected = { ...request, workerVersion: PARSER_WORKER_VERSION,
      verdict: "rejected", code: "MALFORMED" };
    expect(parseParserReply(body(rejected), request)).toEqual(rejected);
  });

  it("fails closed on malformed, oversized, or unexpected JSON", () => {
    const request = createParserRequest({
      mediaType: "application/pdf", sha256: digest, byteSize: 123,
    });
    expect(() => parseParserRequestHeader(Buffer.from("not JSON")))
      .toThrow(ParserProtocolError);
    expect(() => parseParserReply(Buffer.alloc(MAX_PARSER_REPLY_BYTES + 1), request))
      .toThrow(ParserProtocolError);
    expect(() => parseParserReply(Buffer.from([0xff, 0xfe]), request))
      .toThrow(ParserProtocolError);
    expect(() => parseParserReply(body({ ...request, workerVersion: PARSER_WORKER_VERSION,
      verdict: "rejected", code: "UNEXPECTED" }), request))
      .toThrow(ParserProtocolError);
  });

  it("does not let extra caller fields override generated request identity or policy", () => {
    const malicious = { mediaType: "application/pdf" as const, sha256: digest, byteSize: 123,
      requestId: "00000000-0000-4000-8000-000000000000", policyVersion: "old",
      protocolVersion: 999 };
    const request = createParserRequest(malicious);
    expect(request.requestId).not.toBe(malicious.requestId);
    expect(request.policyVersion).not.toBe(malicious.policyVersion);
    expect(request.protocolVersion).toBe(1);
  });
});
