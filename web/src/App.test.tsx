import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

describe("Adeno caregiver entry", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ setup_required: true, ai_available: true }),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leads with one plain next action and the four-part caregiver brief", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Know what is happening. Know what to ask next." }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Finish private setup" })).toHaveAttribute(
      "href",
      "/setup",
    );
    for (const heading of [
      "What we know",
      "What this means",
      "What remains unknown",
      "What to do next",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
  });

  it("has no serious or critical accessibility violations in the empty state", async () => {
    render(<App />);
    await screen.findByText("Plain-language explanations are ready");

    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const materialViolations = results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(materialViolations).toEqual([]);
  });
});
