import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FamilyAccessPanel } from "./FamilyAccessPanel";
afterEach(() => vi.unstubAllGlobals());
const member = { id: "adult-a", displayName: "Invented caregiver", role: "caregiver", memberKind: "adult", status: "active", allProfiles: false,
  intakeProfiles: ["person-a"], days: [{ careProfileId: "person-a", careDay: "2030-04-12", level: "view", grantedBy: { userId: "owner-a", displayName: "Invented owner" }, grantedAt: "2030-04-11T12:00:00Z" }],
  documents: [{ careProfileId: "person-a", documentId: "file-a", displayName: "Invented source.png", basis: "explicit_grant" }] };
function respond(value: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { status })));
}
it("distinguishes scoped reading, intake and publishing without granting anything", async () => {
  respond({ visibility: "self", currentUserId: "adult-a", profiles: [{ id: "person-a", preferredName: "Invented person" }], members: [member] });
  render(<FamilyAccessPanel />);
  await screen.findByRole("heading", { name: "Invented caregiver (you)" });
  expect(screen.getByText("No publishing days granted.")).toBeVisible();
  expect(screen.getByText("Only the care days listed below.")).toBeVisible();
  expect(screen.getByText("Only the files listed below.")).toBeVisible();
  expect(screen.getByText(/The owner can see every account/)).toBeVisible();
  expect(screen.queryByText("All care profiles, records, inbox items and published timelines in this household.")).toBeNull();
  expect(vi.mocked(fetch).mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
});
it("shows disabled and child restrictions instead of implying their role grants publishing", async () => {
  respond({ visibility: "household", currentUserId: "owner-a", profiles: [], members: [
    { ...member, id: "disabled-a", displayName: "Inactive person", status: "disabled", allProfiles: false, days: [], documents: [], intakeProfiles: [] },
    { ...member, displayName: "Young caregiver", memberKind: "child", days: [] },
  ] });
  render(<FamilyAccessPanel />);
  await screen.findByText("No effective access while this account is disabled.");
  expect(screen.getByText("Not permitted for child accounts.")).toBeVisible();
});
it.each([{}, null])("fails closed for malformed access inventory", async value => {
  respond(value); render(<FamilyAccessPanel />);
  await screen.findByText("Access details could not be loaded. Refresh to try again.");
  expect(screen.queryByText("Owner only.")).toBeNull();
});
