import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentConnectionPanel } from "./AgentConnectionPanel";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const grantId = "b".repeat(32);

it("keeps approval disabled when the installation has not enabled its connection path", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ available: false })));
  render(<AgentConnectionPanel csrfToken="invented-csrf" />);
  expect(await screen.findByRole("button", { name: "Create setup instruction" })).toBeDisabled();
  expect(screen.getByRole("checkbox")).toBeDisabled();
});

it("requires explicit consent, shows a nonsecret setup instruction and supports disconnect", async () => {
  let active = false;
  const mutations: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith("/capabilities")) return json({ available: true });
    if (path.endsWith("/list")) return json({ connections: active ? [
      { grantId, expiresAt: 4000000000, state: "active" },
    ] : [] });
    expect(options?.headers).toMatchObject({ "x-csrf-token": "invented-csrf" });
    if (path.endsWith("/disconnect")) { active = false; return new Response(null, { status: 204 }); }
    mutations.push(JSON.parse(String(options?.body))); active = true;
    return json({ grantId, expiresAt: 4000000000 }, 201);
  }));
  render(<AgentConnectionPanel csrfToken="invented-csrf" />);
  await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeDisabled());
  expect(screen.getByRole("button", { name: "Create setup instruction" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create setup instruction" }));
  await screen.findByRole("button", { name: "Disconnect assistant" });
  expect(mutations).toEqual([{ consent: "approved_history_and_sources_v1" }]);
  const instruction = screen.getByLabelText("Setup instruction") as HTMLTextAreaElement;
  expect(instruction.value).toContain(grantId);
  expect(instruction.value).toContain("get_connection_profile and list_care_profiles");
  expect(instruction.value).toContain("ConnectTimeout=10");
  expect(instruction.value).toContain("ConnectionAttempts=1");
  expect(instruction.value).toContain("ServerAliveCountMax=2");
  expect(instruction.value).toContain("selected text and source images");
  expect(instruction.value).not.toContain("invented-csrf");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect assistant" }));
  await screen.findByText("Assistant access disconnected.");
  expect(screen.queryByLabelText("Setup instruction")).toBeNull();
});

it("resumes an existing approval and copies complete setup without issuing new access", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  const fetcher = vi.fn(async (path: string) => path.endsWith("/capabilities") ? json({ available: true })
    : json({ connections: [{ grantId, expiresAt: 4000000000, state: "active" }] }));
  vi.stubGlobal("fetch", fetcher);
  render(<AgentConnectionPanel csrfToken="invented-csrf" />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy setup instruction" }));
  await screen.findByText("Copied. Paste it into your Codex chat.");
  expect(copy.mock.calls[0][0]).toContain(grantId);
  expect(copy.mock.calls[0][0]).not.toContain("invented-csrf");
  expect(fetcher.mock.calls.some(([path]) => path === "/api/v2/agent-connections")).toBe(false);
  expect(screen.getByText(/connection not yet verified/)).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("opens a manual copy fallback when the clipboard is unavailable", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/capabilities") ? json({ available: true })
    : json({ connections: [{ grantId, expiresAt: 4000000000, state: "active" }] })));
  const { container } = render(<AgentConnectionPanel csrfToken="invented-csrf" />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy setup instruction" }));
  await screen.findByText("Clipboard access was blocked. Select and copy the instruction below.");
  expect(container.querySelector("details")).toHaveAttribute("open");
  expect((screen.getByLabelText("Setup instruction") as HTMLTextAreaElement).value).toContain(grantId);
});

it("withholds expired approval and prevents blind mutation retries after an unknown outcome", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.endsWith("/capabilities")) return json({ available: true });
    if (path.endsWith("/list")) return json({ connections: [{ grantId, expiresAt: 100, state: "active" }] });
    attempts++; throw new TypeError("response lost");
  }));
  render(<AgentConnectionPanel csrfToken="invented-csrf" />);
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create setup instruction" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Copy setup instruction" })).toBeNull();
  expect(screen.getByRole("button", { name: "Create setup instruction" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Create setup instruction" }));
  expect(attempts).toBe(1);
});
