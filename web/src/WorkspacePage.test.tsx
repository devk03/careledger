import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { WorkspacePage } from "./WorkspacePage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the four-part care summary without inventing missing facts", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
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
        json: async () => [{ id: "profile-1", preferred_name: "Synthetic loved one" }],
      });
    }
    if (url === "/api/care-profiles/profile-1/workspace") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          profile_id: "profile-1",
          preferred_name: "Synthetic loved one",
          what_we_know: [],
          what_this_means: [],
          what_remains_unknown: [],
          timeline: [],
          questions: [],
          followups: [],
          decisions: [],
        }),
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  }));

  render(<WorkspacePage />);

  expect(await screen.findByRole("heading", { name: "Today for Synthetic loved one" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "What we know" })).toBeInTheDocument();
  expect(screen.getByText("No accepted facts yet.")).toBeInTheDocument();
  expect(screen.getByText("No reviewed interpretations yet.")).toBeInTheDocument();
  expect(screen.getByText("No open unknowns recorded.")).toBeInTheDocument();
});

it("adds a prioritized caregiver question with CSRF protection", async () => {
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
        json: async () => [{ id: "profile-1", preferred_name: "Synthetic loved one" }],
      });
    }
    if (url === "/api/care-profiles/profile-1/workspace") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          profile_id: "profile-1",
          preferred_name: "Synthetic loved one",
          what_we_know: [],
          what_this_means: [],
          what_remains_unknown: [],
          timeline: [],
          questions: [],
          followups: [],
          decisions: [],
        }),
      });
    }
    if (url === "/api/care-profiles/profile-1/questions" && options?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "question-1",
          text: "What does the synthetic result mean?",
          priority: "before_next_visit",
          state: "open",
          due_date: null,
        }),
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<WorkspacePage />);

  fireEvent.change(await screen.findByLabelText("Add a question"), {
    target: { value: "What does the synthetic result mean?" },
  });
  fireEvent.change(screen.getByLabelText("Question priority"), {
    target: { value: "before_next_visit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add question" }));

  expect(await screen.findByText("What does the synthetic result mean?")).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/care-profiles/profile-1/questions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "synthetic-csrf" }),
      }),
    ),
  );
});
