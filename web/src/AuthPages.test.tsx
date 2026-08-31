import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { LoginPage } from "./LoginPage";
import { RecoveryPage } from "./RecoveryPage";
import { SetupPage } from "./SetupPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it("keeps the setup token out of the URL and shows recovery codes once", async () => {
  window.history.replaceState({}, "", "/setup#token=synthetic-private-token");
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      authenticated: true,
      recovery_codes: ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SetupPage />);

  await waitFor(() => expect(window.location.hash).toBe(""));
  fireEvent.change(screen.getByLabelText("Your name"), {
    target: { value: "Synthetic organizer" },
  });
  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Synthetic household" },
  });
  fireEvent.change(screen.getByLabelText("Owner passphrase"), {
    target: { value: "synthetic owner passphrase" },
  });
  fireEvent.change(screen.getByLabelText("Repeat the passphrase"), {
    target: { value: "synthetic owner passphrase" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create the owner account" }));

  expect(
    await screen.findByRole("heading", { name: "Save your recovery codes now." }),
  ).toBeInTheDocument();
  expect(screen.getByText("AAAA-BBBB-CCCC-DDDD")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/auth/setup");
  expect(url).not.toContain("synthetic-private-token");
  expect(request.body).toContain("synthetic-private-token");
});

it("returns a caregiver to the workspace after a successful local login", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ authenticated: true }),
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<LoginPage />);

  fireEvent.change(screen.getByLabelText("Owner passphrase"), {
    target: { value: "synthetic owner passphrase" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByRole("heading", { name: "You’re signed in." })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open the workspace" })).toHaveAttribute("href", "/");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/login",
    expect.objectContaining({ method: "POST", credentials: "same-origin" }),
  );
});

it("replaces recovery codes after a successful account recovery", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ recovery_codes: ["IIII-JJJJ-KKKK-LLLL"] }),
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<RecoveryPage />);

  fireEvent.change(screen.getByLabelText("Recovery code"), {
    target: { value: "AAAA-BBBB-CCCC-DDDD" },
  });
  fireEvent.change(screen.getByLabelText("New owner passphrase"), {
    target: { value: "synthetic replacement passphrase" },
  });
  fireEvent.change(screen.getByLabelText("Repeat the new passphrase"), {
    target: { value: "synthetic replacement passphrase" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Recover access" }));

  expect(await screen.findByRole("heading", { name: "Access has been recovered." })).toBeInTheDocument();
  expect(screen.getByText("IIII-JJJJ-KKKK-LLLL")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/recover",
    expect.objectContaining({ method: "POST", credentials: "same-origin" }),
  );
});
