import { describe, expect, it } from "vitest";
import type { HistoryPage } from "@adeno/contracts";

import { dayItemsFromHistory } from "./timeline";

describe("timeline view mapping", () => {
  it("preserves sparse dates, multiple files and family attribution without analysis", () => {
    const history: HistoryPage = {
      throughDay: "2030-04-12",
      focusFromDay: null,
      nextBeforeDay: null,
      meaning: "currently_recorded_history",
      days: [{
        id: "sample-day", careProfileId: "sample-profile", day: "2030-04-12", revision: 1,
        sources: [
          { documentId: "sample-a", displayName: "fictional-a.pdf", uploadedAt: "2030-04-14T10:00:00Z", sourceSha256: "a".repeat(64), pageNumbers: [1] },
          { documentId: "sample-b", displayName: "fictional-b.pdf", uploadedAt: "2030-04-15T10:00:00Z", sourceSha256: "b".repeat(64), pageNumbers: [1] },
        ],
        statements: [
          { id: "sample-note", text: "Family noted a question.", attribution: "family_note", authorLabel: "Example adult", status: "uncertain" },
          { id: "sample-fact", text: "Synthetic source statement.", attribution: "document", sourceDocumentId: "sample-a", pageNumber: 1, status: "occurred" },
        ],
      }],
    };

    expect(dayItemsFromHistory(history)).toEqual([{
      id: "sample-day",
      day: "2030-04-12",
      files: [
        { id: "sample-a", name: "fictional-a.pdf" },
        { id: "sample-b", name: "fictional-b.pdf" },
      ],
      notes: [{ id: "sample-note", text: "Family noted a question.", author: "Example adult" }],
    }]);
  });
});
