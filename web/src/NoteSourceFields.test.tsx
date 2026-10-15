import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteSourceFields } from "./NoteSourceFields";
afterEach(() => vi.unstubAllGlobals());
it("requires a reported person and a file/page for document-sourced notes", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith("/capabilities") ? { available: true } : {
    documents: [{ documentId: "invented-source", displayName: "Invented source.png", pageCount: 1 }], nextCursor: null,
  }), { status: 200 })));
  render(<form><NoteSourceFields profileId="invented-person" /></form>);
  const reporter = await screen.findByLabelText("Reported by");
  expect(reporter).toBeRequired(); expect(reporter).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Information source"), { target: { value: "document" } });
  expect(screen.getByLabelText("Source file")).toBeRequired();
  fireEvent.change(screen.getByLabelText("Source file"), { target: { value: "invented-source" } });
  expect(screen.getByLabelText("Source page")).toHaveAttribute("max", "1");
  expect(screen.getByLabelText("Source page")).toHaveValue(1);
});
it("does not offer fields that the current schema cannot save", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: false }), { status: 200 })));
  render(<NoteSourceFields profileId="invented-person" />);
  await screen.findByText(/Separate reporter and source fields are not available yet/);
  expect(screen.queryByLabelText("Reported by")).toBeNull();
});
