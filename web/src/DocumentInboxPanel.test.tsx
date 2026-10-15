import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentInboxPanel } from "./DocumentInboxPanel";
afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const record = { documentId: "document-a", displayName: "Invented record.png", sourceSha256: "a".repeat(64),
  mediaType: "image/png", byteSize: 100, pageCount: 1, uploadedAt: "2030-04-13T12:00:00.000Z",
  pendingDayProposals: [{ revisionId: "revision-a", careDay: "2030-04-12" }] };
function fakeApi(outcome: "success" | "unconfirmed" = "success") {
  const writes: unknown[] = []; let published = false;
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith("/capabilities")) return json({ available: true });
    if (path.endsWith("/documents/inbox")) return json({ documents: [{ ...record, pendingDayProposals: published ? [] : record.pendingDayProposals }], nextCursor: null });
    if (path.endsWith("/reviews/document-days/revision-a")) return json({ ...record, revisionId: "revision-a",
      careDay: "2030-04-12", expectedDayRevision: 3, authorLabel: "Invented author", state: "proposed" });
    if (path.endsWith("/timeline/document-days/revision-a/review")) {
      writes.push(JSON.parse(String(options?.body))); expect(options?.headers).toMatchObject({ "x-csrf-token": "fictional-csrf" });
      if (outcome === "unconfirmed") throw new Error("Invented transport failure");
      published = true; return json({ ok: true, revision: 4, snapshotId: "snapshot-a" });
    }
    if (path.endsWith("/day-proposals")) { writes.push(JSON.parse(String(options?.body))); return json({ ok: true, revisionId: "revision-b" }); }
    throw new Error("Unexpected synthetic endpoint");
  });
  vi.stubGlobal("fetch", fetcher); return { writes, fetcher };
}
const panel = (onPublished = vi.fn()) => render(<DocumentInboxPanel profileId="profile-a" csrfToken="fictional-csrf" refreshKey={0} onPublished={onPublished} />);

it("keeps record actions unavailable when capability discovery is disabled", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ available: false })); vi.stubGlobal("fetch", fetcher); panel();
  await screen.findByText("Record review is unavailable on this installation.");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); expect(screen.queryByText("Refresh record inbox")).toBeNull();
});

it("requires the exact original to load and explicit human confirmation before publishing the observed revision", async () => {
  const { writes } = fakeApi(); const published = vi.fn(); panel(published);
  fireEvent.click(await screen.findByRole("button", { name: "Review day 2030-04-12 for Invented record.png" }));
  await screen.findByText("Proposed care day: 2030-04-12");
  const approve = screen.getByRole("button", { name: "Approve record and publish" }); expect(approve).toBeDisabled();
  const image = screen.getByRole("img", { name: "Preserved original: Invented record.png" });
  expect(image.getAttribute("src")).toContain(`expectedSha256=${record.sourceSha256}`);
  fireEvent.load(image); fireEvent.click(screen.getByRole("checkbox")); expect(approve).toBeEnabled();
  fireEvent.click(approve); await screen.findByText("Record published to the care day.");
  expect(writes).toEqual([{ decision: "accepted", expectedDayRevision: 3 }]); expect(published).toHaveBeenCalledTimes(1);
});

it("requires refresh after an unconfirmed publication and does not retry or reuse the old approval", async () => {
  const { writes } = fakeApi("unconfirmed"); panel();
  fireEvent.click(await screen.findByRole("button", { name: "Review day 2030-04-12 for Invented record.png" }));
  const image = await screen.findByRole("img"); fireEvent.load(image); fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve record and publish" }));
  await screen.findByText("The result is unconfirmed. Refresh the inbox before trying again.");
  expect(writes).toHaveLength(1); expect(screen.queryByRole("button", { name: "Approve record and publish" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open original: Invented record.png" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh record inbox" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Open original: Invented record.png" })).toBeEnabled());
  expect(screen.queryByRole("checkbox")).toBeNull(); expect(writes).toHaveLength(1);
});

it("never fills the care day from upload time and blocks approval after image failure", async () => {
  const { writes } = fakeApi(); panel();
  fireEvent.click(await screen.findByRole("button", { name: "Open original: Invented record.png" }));
  expect(screen.getByLabelText("Care day for this record")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Care day for this record"), { target: { value: "2030-04-12" } });
  fireEvent.click(screen.getByRole("button", { name: "Save day for review" }));
  await screen.findByText("Care day saved for review."); expect(writes).toEqual([{ careDay: "2030-04-12" }]);
  fireEvent.click(screen.getByRole("button", { name: "Review day 2030-04-12 for Invented record.png" }));
  const image = await screen.findByRole("img"); fireEvent.error(image);
  await screen.findByText("The original image could not be opened.");
  expect(screen.getByRole("button", { name: "Approve record and publish" })).toBeDisabled();
});

it.each([
  ["2030-04-12_invented.png", "2030-04-12"],
  ["2030-02-31_invented.png", ""],
  ["2030-99-12_invented.png", ""],
  ["2030-04-12_invented-PDF-PAGE-COPY-1.png", "2030-04-12"],
])("offers a valid filename date without treating upload time as the care day: %s", async (name, expected) => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith("/capabilities")) return json({ available: true });
    if (path.endsWith("/documents/inbox")) return json({ documents: [{ ...record, displayName: name, pendingDayProposals: [] }], nextCursor: null });
    writes.push(options); throw new Error("No writes expected");
  }));
  panel();
  fireEvent.click(await screen.findByRole("button", { name: `Open original: ${name}` }));
  expect(screen.getByLabelText("Care day for this record")).toHaveValue(expected);
  expect(writes).toEqual([]);
  if (name.includes("PDF-PAGE-COPY")) expect(screen.getByText(/This upload preserves the page image, not the original PDF/)).toBeVisible();
  const timestamp = screen.getByText((_, element) => element?.tagName === "TIME");
  expect(timestamp).toHaveAttribute("datetime", record.uploadedAt);
  expect(timestamp).toHaveAttribute("title", record.uploadedAt);
  expect(screen.getByText(/Upload time is not the care day/)).toBeInTheDocument();
});
