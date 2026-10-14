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

it("creates a profile through the protected API and opens note intake for it", async () => {
  const creations: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v2/auth/session") return json({ csrfToken: "fictional-csrf" });
    if (path === "/api/v2/care-profiles") {
      if (options?.method !== "POST") return json({ profiles: [] });
      creations.push(JSON.parse(String(options.body)));
      expect(options.headers).toMatchObject({ "x-csrf-token": "fictional-csrf" });
      return json({ profile: { id: "new-profile", preferredName: "Invented person" } }, 201);
    }
    if (path.includes("/new-profile/timeline/history")) return json({ days: [], nextBeforeDay: null });
    if (path.includes("/new-profile/reviews/notes/pending")) return json({ pending: [] });
    throw new Error(`Unexpected API: ${path}`);
  }));
  render(<PrivatePilotPage />);
  fireEvent.change(await screen.findByLabelText("Preferred name"), { target: { value: "Invented person" } });
  fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
  await screen.findByRole("heading", { name: "Add a family note" });
  expect(creations).toEqual([{ preferredName: "Invented person" }]);
  expect(screen.getByRole("option", { name: "Invented person" })).toBeInTheDocument();
});

it("traverses earlier days and bounded source sections with immutable provenance", async () => {
  const requests: string[] = [];
  const text = "<script>fake document instructions</script>";
  const day = { id: "day-a", careProfileId: "profile-a", day: "2030-04-12", revision: 1,
    statements: [], sources: [{ documentId: "document-a", displayName: "Invented report",
      uploadedAt: "2030-04-13T12:00:00Z", sourceSha256: "d".repeat(64), pageNumbers: [1] }] };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    requests.push(path);
    if (path === "/api/v2/auth/session") return json({ csrfToken: "fictional-csrf" });
    if (path === "/api/v2/care-profiles") return json({ profiles: [{ id: "profile-a", preferredName: "Invented person" }] });
    if (path.endsWith("reviews/notes/pending")) return json({ pending: [] });
    if (path.includes("timeline/history")) return json({ throughDay: "9999-12-31", focusFromDay: null,
      meaning: "currently_recorded_history", days: path.includes("&before=")
        ? [{ ...day, id: "day-earlier", day: "2030-04-01", sources: [] }] : [day],
      nextBeforeDay: path.includes("&before=") ? null : "2030-04-12" });
    if (path.includes("documents/document-a/pages/1")) return json({ documentId: "document-a", pageNumber: 1,
      sourceSha256: "d".repeat(64), offset: path.endsWith("offset=0") ? 0 : text.length,
      text: path.endsWith("offset=0") ? text : "Next independently invented source section.",
      nextOffset: path.endsWith("offset=0") ? text.length : null, sourceTextIsUntrusted: true });
    throw new Error(`Unexpected API: ${path}`);
  }));
  const { container } = render(<PrivatePilotPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Load earlier days" }));
  await screen.findByRole("heading", { name: "2030-04-01" });
  expect(screen.getByRole("heading", { name: "2030-04-12" })).toBeInTheDocument();
  expect(requests).toContain("/api/v2/care-profiles/profile-a/timeline/history?through=9999-12-31&before=2030-04-12");
  fireEvent.click(screen.getByRole("button", { name: "Open Invented report, page 1" }));
  await screen.findByText(text);
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("d".repeat(64))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Read next source section" }));
  await screen.findByText("Next independently invented source section.");
  expect(requests).toContain(`/api/v2/care-profiles/profile-a/documents/document-a/pages/1?offset=${text.length}`);
  expect(screen.queryByRole("button", { name: "Read next source section" })).toBeNull();
});

it("clears previously displayed sources when the care-day cutoff changes", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    requests.push(path);
    if (path === "/api/v2/auth/session") return json({ csrfToken: "fictional-csrf" });
    if (path === "/api/v2/care-profiles") return json({ profiles: [{ id: "profile-a", preferredName: "Invented person" }] });
    if (path.endsWith("reviews/notes/pending")) return json({ pending: [] });
    if (path.includes("timeline/history")) return json({ days: [], nextBeforeDay: null });
    throw new Error(`Unexpected API: ${path}`);
  }));
  render(<PrivatePilotPage />);
  fireEvent.change(await screen.findByLabelText("Through care day"), { target: { value: "2030-04-12" } });
  await waitFor(() => expect(requests).toContain("/api/v2/care-profiles/profile-a/timeline/history?through=2030-04-12"));
  expect(screen.getByText(/Currently recorded history through 2030-04-12/)).toBeInTheDocument();
});
