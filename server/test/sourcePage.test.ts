import { describe, expect, it } from "vitest";

import {
  getApprovedSourcePage,
  InvalidPageRequest,
  SourcePageNotFound,
} from "../src/timeline/sourcePage.js";
import type { ApprovedPageRepository, TimelineRepository } from "../src/timeline/types.js";

const scope = { householdId: "fictional-family", userId: "fictional-adult" };
const timeline: TimelineRepository = {
  profileBelongsToHousehold: async () => true,
  listApprovedDays: async () => [],
};

describe("approved source page read", () => {
  it("rejects invalid page numbers before touching storage", async () => {
    let reads = 0;
    const pages: ApprovedPageRepository = {
      readApprovedPageChunk: async () => { reads += 1; return null; },
    };
    await expect(getApprovedSourcePage(pages, timeline, scope, {
      careProfileId: "profile", documentId: "document", pageNumber: 0,
    })).rejects.toBeInstanceOf(InvalidPageRequest);
    expect(reads).toBe(0);
  });

  it("does not reveal whether an unapproved page exists", async () => {
    const pages: ApprovedPageRepository = { readApprovedPageChunk: async (input) => {
      expect(input).toMatchObject({ householdId: "fictional-family", userId: "fictional-adult" });
      return null;
    } };
    await expect(getApprovedSourcePage(pages, timeline, scope, {
      careProfileId: "profile", documentId: "document", pageNumber: 1,
    })).rejects.toBeInstanceOf(SourcePageNotFound);
  });

  it("fails closed on an oversized or mismatched repository result", async () => {
    const pages: ApprovedPageRepository = {
      readApprovedPageChunk: async () => ({
        documentId: "wrong-document", pageNumber: 1, sourceSha256: "a".repeat(64),
        offset: 0, text: "x".repeat(6_001), nextOffset: null,
      }),
    };
    await expect(getApprovedSourcePage(pages, timeline, scope, {
      careProfileId: "profile", documentId: "document", pageNumber: 1,
    })).rejects.toThrow("invalid data");
  });

  it.each([0, 1, 7, 100])("rejects source cursors that repeat or skip text: %s", async nextOffset => {
    const pages: ApprovedPageRepository = { readApprovedPageChunk: async () => ({
      documentId: "document", pageNumber: 1, sourceSha256: "a".repeat(64),
      offset: 0, text: "abc", nextOffset,
    }) };
    await expect(getApprovedSourcePage(pages, timeline, scope, {
      careProfileId: "profile", documentId: "document", pageNumber: 1,
    })).rejects.toThrow("invalid data");
  });

  it("returns consecutive source chunks with an explicit untrusted-evidence label", async () => {
    const pages: ApprovedPageRepository = { readApprovedPageChunk: async () => ({
      documentId: "document", pageNumber: 1, sourceSha256: "a".repeat(64),
      offset: 3, text: "def", nextOffset: 6,
    }) };
    expect(await getApprovedSourcePage(pages, timeline, scope, {
      careProfileId: "profile", documentId: "document", pageNumber: 1, offset: 3,
    })).toMatchObject({ offset: 3, text: "def", nextOffset: 6, sourceTextIsUntrusted: true });
  });
});
