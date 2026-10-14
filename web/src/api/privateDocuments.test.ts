import { afterEach, expect, it, vi } from "vitest";
import { DocumentWorkflowError, listDocumentInbox, proposeDocumentDay, reviewDocumentDayProposal } from "./privateDocuments";
afterEach(() => vi.unstubAllGlobals());

it("uses same-origin private reads and encodes both pagination fields", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [], nextCursor: null })));
  vi.stubGlobal("fetch", fetcher);
  await listDocumentInbox("profile/a", { uploadedAt: 100, documentId: "doc a" });
  expect(fetcher).toHaveBeenCalledWith("/api/v2/care-profiles/profile%2Fa/documents/inbox?beforeUploadedAt=100&beforeDocumentId=doc+a",
    { credentials: "same-origin", cache: "no-store" });
});

it("sends an explicit day and observed revision with CSRF, and never retries an uncertain mutation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ revisionId: "revision-a" })))
    .mockRejectedValueOnce(new Error("Invented transport failure"));
  vi.stubGlobal("fetch", fetcher);
  await proposeDocumentDay("profile-a", "document-a", "2030-04-12", "fictional-csrf");
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ careDay: "2030-04-12" });
  const result = reviewDocumentDayProposal("profile-a", { revisionId: "revision-a", expectedDayRevision: 4 }, "accepted", "fictional-csrf");
  await expect(result).rejects.toMatchObject({ unconfirmed: true, status: null });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1].headers["x-csrf-token"]).toBe("fictional-csrf");
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ decision: "accepted", expectedDayRevision: 4 });
});

it("redacts storage errors and marks malformed mutation success as unconfirmed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("Invented private storage details", { status: 503 }))
    .mockResolvedValueOnce(new Response("unparseable")));
  await expect(proposeDocumentDay("profile-a", "document-a", "2030-04-12", "fictional-csrf"))
    .rejects.toMatchObject({ unconfirmed: true, message: "The result is unconfirmed. Refresh the inbox before trying again." });
  await expect(reviewDocumentDayProposal("profile-a", { revisionId: "revision-a", expectedDayRevision: 0 }, "rejected", "fictional-csrf"))
    .rejects.toBeInstanceOf(DocumentWorkflowError);
});
