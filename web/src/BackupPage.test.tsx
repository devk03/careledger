import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { BackupPage } from "./BackupPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("requires the owner password and two matching backup passphrases", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      authenticated: true,
      csrf_token: "synthetic-csrf",
      user: { display_name: "Synthetic organizer", role: "owner" },
    }),
  }));
  render(<BackupPage />);

  const button = await screen.findByRole("button", { name: "Create encrypted backup" });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("CareLedger account password"), {
    target: { value: "synthetic owner passphrase" },
  });
  fireEvent.change(screen.getByLabelText("New backup passphrase"), {
    target: { value: "synthetic backup passphrase" },
  });
  fireEvent.change(screen.getByLabelText("Repeat backup passphrase"), {
    target: { value: "does not match" },
  });
  expect(screen.getByText("The two backup passphrases do not match.")).toBeInTheDocument();
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Repeat backup passphrase"), {
    target: { value: "synthetic backup passphrase" },
  });
  expect(button).toBeEnabled();
});
