import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ProvenanceTrail } from "./ProvenanceTrail";
it("keeps the reported person distinct from the entry account and reviewer", () => {
  render(<ProvenanceTrail value={{ reporterLabel: "Invented reporter", sourceKind: "clinician_communication", sourceDescription: "An invented appointment message.",
    recordedBy: { userId: "caregiver", displayName: "Invented typist" }, recordedAt: "2030-04-12T12:00:00Z",
    reviewedBy: { userId: "reviewer", displayName: "Invented reviewer" }, reviewedAt: "2030-04-13T12:00:00Z" }} />);
  expect(screen.getByText("Invented reporter")).toBeVisible();
  expect(screen.getByText("Invented typist")).toBeVisible();
  expect(screen.getByText(/Invented reviewer/)).toBeVisible();
  expect(screen.getByText("Reported clinician communication")).toBeVisible();
});
it("does not invent a reporter from a historical account name", () => {
  render(<ProvenanceTrail fallbackAuthor="Invented account" />);
  expect(screen.getByText("Invented account")).toBeVisible();
  expect(screen.getByText("Not recorded; the entry account does not identify the reporter.")).toBeVisible();
  expect(screen.getByText("No source description recorded.")).toBeVisible();
});
