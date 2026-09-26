import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { RecordsPage } from "./RecordsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("creates the first care profile and keeps the caregiver on the upload path", async () => {
  const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer" },
        }),
      });
    }
    if (url === "/api/care-profiles" && options?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "profile-1",
          preferred_name: "Synthetic loved one",
          created_at: 1,
        }),
      });
    }
    if (url === "/api/care-profiles") {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url === "/api/care-profiles/profile-1/documents") {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecordsPage />);

  fireEvent.change(await screen.findByLabelText("Who are you helping?"), {
    target: { value: "Synthetic loved one" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create the care profile" }));

  expect(await screen.findByLabelText("Care profile")).toHaveValue("profile-1");
  expect(screen.getByText("Choose a PDF or clear photo")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/care-profiles",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-CSRF-Token": "synthetic-csrf" }),
    }),
  );
});

it("adds an admitted record and shows its source fingerprint", async () => {
  const record = {
    id: "document-1",
    display_name: "synthetic.png",
    media_type: "image/png",
    source_sha256: "a".repeat(64),
    byte_size: 4096,
    page_count: 1,
    status: "processing",
    scan_verdict: "not_configured",
    duplicate_source: false,
  };
  const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer" },
        }),
      });
    }
    if (url === "/api/care-profiles") {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: "profile-1", preferred_name: "Synthetic loved one", created_at: 1 },
        ],
      });
    }
    if (url === "/api/care-profiles/profile-1/documents" && options?.method === "POST") {
      return Promise.resolve({ ok: true, json: async () => record });
    }
    if (url === "/api/care-profiles/profile-1/documents") {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecordsPage />);

  const input = (await screen.findByLabelText("Choose a PDF or clear photo")) as HTMLInputElement;
  const file = new File(["synthetic"], "synthetic.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  const submit = screen.getByRole("button", { name: "Add this record" });
  expect(submit).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url, options]) =>
    url === "/api/care-profiles/profile-1/documents" && options?.method === "POST",
  )).toBe(false);
  fireEvent.click(screen.getByLabelText(
    "I understand the person running this server can read the file I add.",
  ));
  expect(submit).toBeEnabled();
  fireEvent.click(submit);

  expect(await screen.findByRole("heading", { name: "synthetic.png" })).toBeInTheDocument();
  expect(screen.getByText(`Source fingerprint ${"a".repeat(12)}…`)).toBeInTheDocument();
  expect(screen.getByText("File structure checked · malware scanner not configured")).toBeInTheDocument();
  expect(submit).toBeDisabled();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/care-profiles/profile-1/documents",
      expect.objectContaining({
        method: "POST",
        headers: { "X-CSRF-Token": "synthetic-csrf" },
      }),
    ),
  );
});

it("clears the file and acknowledgment when the care profile changes", async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/auth/session") return Promise.resolve({ ok: true,
      json: async () => ({ authenticated: true, csrf_token: "synthetic-csrf",
        user: { display_name: "Synthetic organizer" } }) });
    if (url === "/api/care-profiles") return Promise.resolve({ ok: true,
      json: async () => [
        { id: "profile-1", preferred_name: "Fictional A", created_at: 1 },
        { id: "profile-2", preferred_name: "Fictional B", created_at: 1 },
      ] });
    if (url.endsWith("/documents")) return Promise.resolve({ ok: true,
      json: async () => [] });
    throw new Error(`Unexpected test URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecordsPage />);
  const fileInput = (await screen.findByLabelText("Choose a PDF or clear photo")) as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(["fiction"],
    "fictional.png", { type: "image/png" })] } });
  fireEvent.click(screen.getByLabelText(
    "I understand the person running this server can read the file I add.",
  ));
  const submit = screen.getByRole("button", { name: "Add this record" });
  expect(submit).toBeEnabled();
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Care profile"),
      { target: { value: "profile-2" } });
  });
  expect(submit).toBeDisabled();
  expect(screen.getByText("Choose a PDF or clear photo")).toBeInTheDocument();
  expect(screen.getByLabelText(
    "I understand the person running this server can read the file I add.",
  )).not.toBeChecked();
  expect(fetchMock.mock.calls.some(([url, options]) =>
    String(url).endsWith("/documents") && options?.method === "POST",
  )).toBe(false);
});

it("reveals no record workspace when there is no authenticated session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: false, csrf_token: null, user: null }),
    }),
  );
  render(<RecordsPage />);

  expect(
    await screen.findByRole("heading", { name: "Sign in to open the family workspace." }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Source library")).not.toBeInTheDocument();
});

it("requires an explicit external-transfer confirmation before analysis", async () => {
  const readyRecord = {
    id: "document-ready",
    display_name: "synthetic-ready.pdf",
    media_type: "application/pdf",
    source_sha256: "b".repeat(64),
    byte_size: 2048,
    page_count: 2,
    status: "ready",
    scan_verdict: "clean",
    duplicate_source: false,
  };
  const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer" },
        }),
      });
    }
    if (url === "/api/care-profiles") {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: "profile-1", preferred_name: "Synthetic loved one", created_at: 1 },
        ],
      });
    }
    if (url === "/api/ai/status") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          enabled: true,
          provider: "openrouter",
          model: "synthetic/model",
          external_transfer_required: true,
        }),
      });
    }
    if (url === "/api/care-profiles/profile-1/documents") {
      return Promise.resolve({ ok: true, json: async () => [readyRecord] });
    }
    if (url === "/api/documents/document-ready/analysis" && options?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ job_id: "job-1", state: "queued" }),
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecordsPage />);

  fireEvent.click(await screen.findByRole("button", { name: "Explain this record" }));
  expect(screen.getByText("Send this original for an explanation?")).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.some(([url, options]) =>
      url === "/api/documents/document-ready/analysis" && options?.method === "POST",
    ),
  ).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Send and explain" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/documents/document-ready/analysis",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ acknowledge_external_transfer: true }),
      }),
    ),
  );
});

it("keeps model output untrusted until the caregiver accepts it", async () => {
  const reviewRecord = {
    id: "document-review",
    display_name: "synthetic-review.png",
    media_type: "image/png",
    source_sha256: "c".repeat(64),
    byte_size: 1024,
    page_count: 1,
    status: "needs_review",
    scan_verdict: "clean",
    duplicate_source: false,
  };
  const proposal = {
    revision_id: "revision-1",
    claim_id: "claim-1",
    statement: "A possible synthetic finding is documented.",
    plain_language: "The source says this may be present, but it is uncertain.",
    kind: "clinician_interpretation",
    fact_type: "imaging_finding",
    certainty: "qualified",
    qualifier_text: "possible",
    event_date: null,
    citations: [
      {
        document_id: "document-review",
        page_number: 1,
        quote: "A possible synthetic finding is documented.",
      },
    ],
  };
  const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/auth/session") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer" },
        }),
      });
    }
    if (url === "/api/care-profiles") {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: "profile-1", preferred_name: "Synthetic loved one", created_at: 1 },
        ],
      });
    }
    if (url === "/api/ai/status") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ enabled: false, provider: "disabled", model: null }),
      });
    }
    if (url === "/api/care-profiles/profile-1/documents") {
      return Promise.resolve({ ok: true, json: async () => [reviewRecord] });
    }
    if (url === "/api/documents/document-review/proposals") {
      return Promise.resolve({ ok: true, json: async () => [proposal] });
    }
    if (url === "/api/evidence/revision-1/review" && options?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ document_status: "complete" }),
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecordsPage />);

  fireEvent.click(await screen.findByRole("button", { name: "Review proposed facts" }));
  expect(await screen.findByText("AI draft · not trusted yet")).toBeInTheDocument();
  expect(screen.getByText("Page 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Accept as sourced" }));

  await waitFor(() => expect(screen.getByText("Review complete.")).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/evidence/revision-1/review",
    expect.objectContaining({ body: JSON.stringify({ decision: "accepted" }) }),
  );
});
