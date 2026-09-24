import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubLink } from "./GitHubLink";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows a real zero without confusing it with unavailable", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stars: 0, stale: false }) });
  vi.stubGlobal("fetch", fetcher);
  render(<GitHubLink />);
  expect(await screen.findByRole("link", { name: "adeno on GitHub, 0 stars" })).toHaveAttribute("href", "https://github.com/devk03/careledger");
  expect(fetcher).toHaveBeenCalledWith("/api/public/project", expect.objectContaining({credentials: "same-origin"}));
});
it("keeps the link working when counts are unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  render(<GitHubLink />);
  expect(await screen.findByRole("link", { name: "adeno on GitHub" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.queryByText("0")).toBeNull();
});
it("marks a stale last-known count", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({stars: 42, stale: true}) }));
  render(<GitHubLink />);
  expect(await screen.findByRole("link", {name: "adeno on GitHub, 42 stars, last known count"})).toBeInTheDocument();
});
