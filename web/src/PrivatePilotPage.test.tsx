import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivatePilotPage } from "./PrivatePilotPage";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "content-type": "application/json" } });

it("requires explicit sign-in and keeps credentials in a POST body", async () => {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v2/auth/session") return json({}, 401);
    if (path === "/api/v2/auth/setup-status") return json({ setupRequired: false });
    if (path === "/api/v2/auth/login") {
      expect(options?.method).toBe("POST");
      expect(JSON.parse(String(options?.body))).toEqual({ loginName: "owner", password: "fictional-password" });
      return json({ csrfToken: "fictional-csrf" });
    }
    if (path === "/api/v2/care-profiles") return json({ profiles: [] });
    throw new Error(`Unexpected API: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<PrivatePilotPage />);
  await screen.findByRole("heading", { name: "Sign in" });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fictional-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("button", { name: "Sign out" });
  expect(fetcher.mock.calls.some(([path]) => path.includes("fictional-password"))).toBe(false);
});

it("shows a proposal's actual text before an explicit approval with its observed revision", async () => {
  const reviews: unknown[] = [];
  let published = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v2/auth/session") return json({ csrfToken: "fictional-csrf" });
    if (path === "/api/v2/care-profiles") return json({ profiles: [{ id: "profile-a", preferredName: "Invented person" }] });
    if (path.endsWith("timeline/history?through=9999-12-31")) return json({ days: [], nextBeforeDay: null });
    if (path.endsWith("reviews/notes/pending")) return json({ pending: published ? [] : [
      { revisionId: "revision-a", targetCareDay: "2030-04-12" },
    ] });
    if (path.endsWith("reviews/notes/revision-a")) return json({ note: {
      revisionId: "revision-a", careDay: "2030-04-12", body: "Wholly invented family observation.",
      authorLabel: "Fictional author", expectedDayRevision: 3, state: "proposed",
    } });
    if (path.endsWith("timeline/notes/revision-a/review")) {
      reviews.push(JSON.parse(String(options?.body)));
      expect(options?.headers).toMatchObject({ "x-csrf-token": "fictional-csrf" });
      published = true;
      return json({ ok: true, revision: 4 });
    }
    throw new Error(`Unexpected API: ${path}`);
  }));
  render(<PrivatePilotPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Review note for 2030-04-12" }));
  await screen.findByText("Wholly invented family observation.");
  expect(reviews).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Approve and publish" }));
  await screen.findByText("Note published to the care day.");
  expect(reviews).toEqual([{ decision: "accepted", expectedDayRevision: 3 }]);
  await waitFor(() => expect(screen.queryByText("Wholly invented family observation.")).toBeNull());
});
