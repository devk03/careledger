import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicFooter } from "./InformationPage";
import { publicReleaseRevision } from "./releaseRevision";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("accepts only a complete lowercase public commit ID", () => {
  const sha = "a".repeat(40);
  expect(publicReleaseRevision(sha)).toBe(sha);
  for (const invalid of [undefined, "", "a".repeat(39), "A".repeat(40), "g".repeat(40), "a".repeat(40) + "/evil"]) {
    expect(publicReleaseRevision(invalid)).toBeNull();
  }
});

it("links the operator-supplied release revision without changing the repository link", () => {
  const sha = "b".repeat(40);
  vi.stubEnv("VITE_ADENO_RELEASE_SHA", sha);
  render(<PublicFooter />);
  expect(screen.getByRole("link", { name: `View source commit ${sha} on GitHub` }))
    .toHaveAttribute("href", `https://github.com/devk03/careledger/commit/${sha}`);
  expect(screen.getByRole("link", { name: /View adeno source on GitHub/ }))
    .toHaveAttribute("href", "https://github.com/devk03/careledger");
});

it("does not assert a revision when no valid commit was supplied", () => {
  vi.stubEnv("VITE_ADENO_RELEASE_SHA", "unknown");
  render(<PublicFooter />);
  expect(screen.queryByText(/^Source [0-9a-f]{8}$/)).toBeNull();
});
