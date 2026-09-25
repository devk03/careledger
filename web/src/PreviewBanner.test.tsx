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

it("hides the warning only after an explicit non-preview response", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok: true, json: async () => ({restricted_preview: false})}));
  render(<PreviewBanner />);
  await waitFor(() => expect(screen.queryByLabelText("Preview safety notice")).not.toBeInTheDocument());
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
