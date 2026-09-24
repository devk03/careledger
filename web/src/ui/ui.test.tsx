import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, ButtonLink, Field, Notice } from "./index";

describe("adeno shared controls", () => {
  it("defaults actions to non-submit buttons and blocks duplicate loading clicks", () => {
    const action = vi.fn();
    render(<Button loading onClick={action}>Saving note…</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(action).not.toHaveBeenCalled();
  });
  it("preserves link semantics and explicit form-submit behavior", () => {
    render(<><Button type="submit">Save</Button><ButtonLink href="/records">Records</ButtonLink></>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
    expect(screen.getByRole("link")).toHaveAttribute("href", "/records");
  });
  it("connects field labels and errors while preserving native attributes", () => {
    render(<Field id="sample" label="Sample passphrase" type="password" required minLength={12} error="Use 12 characters." />);
    const field = screen.getByLabelText("Sample passphrase");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Use 12 characters.");
    expect(field).toHaveAttribute("minlength", "12");
    expect(field).toBeRequired();
  });
  it("announces errors separately from success", () => {
    render(<><Notice>Try the sample again.</Notice><Notice tone="success">Sample saved.</Notice></>);
    expect(screen.getByRole("alert")).toHaveTextContent("Try the sample again.");
    expect(screen.getByRole("status")).toHaveTextContent("Sample saved.");
  });
});
