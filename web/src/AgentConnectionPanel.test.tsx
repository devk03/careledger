import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentConnectionPanel } from "./AgentConnectionPanel";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const grantId = "b".repeat(32);

it("keeps approval disabled when the installation has not enabled its connection path", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ available: false })));
  render(<AgentConnectionPanel csrfToken="invented-csrf" />);
  expect(await screen.findByRole("button", { name: "Approve assistant access" })).toBeDisabled();
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
  expect(screen.getByRole("button", { name: "Approve assistant access" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Approve assistant access" }));
  await screen.findByRole("button", { name: "Disconnect assistant" });
  expect(mutations).toEqual([{ consent: "approved_history_and_sources_v1" }]);
  const instruction = screen.getByLabelText("Connection instruction") as HTMLTextAreaElement;
  expect(instruction.value).toContain(grantId);
  expect(instruction.value).toContain("get_connection_profile");
  expect(instruction.value).not.toContain("invented-csrf");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect assistant" }));
  await screen.findByText("Assistant access disconnected.");
  expect(screen.queryByLabelText("Connection instruction")).toBeNull();
});
