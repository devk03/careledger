import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewBanner } from "./PreviewBanner";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the fictional-only warning in staging", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({restricted_preview: true})}));
  render(<PreviewBanner />);
  expect(await screen.findByLabelText("Preview safety notice")).toHaveTextContent("fictional records only");
  expect(screen.getByRole("link", {name: "Read the privacy model"})).toHaveAttribute("href", "/privacy");
});

it("keeps the server-readable disclosure outside restricted preview", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({restricted_preview: false})}));
  render(<PreviewBanner />);
  const notice = await screen.findByLabelText("Record privacy notice");
  expect(notice).toHaveTextContent("records are server-readable");
  expect(notice).toHaveTextContent("not end-to-end encrypted");
  expect(notice).not.toHaveTextContent("fictional records only");
  expect(screen.getByRole("link", {name: "Read the privacy model"}))
    .toHaveAttribute("href", "/privacy");
});

it("keeps the disclosure beside non-preview file intake", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({restricted_preview: false})}));
  render(<PreviewBanner placement="upload" />);
  await waitFor(() => expect(screen.getByLabelText("Upload privacy notice"))
    .toHaveTextContent("server you trust"));
});

it("keeps the warning if runtime status is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  render(<PreviewBanner />);
  expect(await screen.findByLabelText("Preview safety notice")).toBeInTheDocument();
});

it("keeps the warning if runtime status is malformed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({restricted_preview: "false"})}));
  render(<PreviewBanner />);
  expect(await screen.findByLabelText("Preview safety notice")).toBeInTheDocument();
});
