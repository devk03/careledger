import { describe, expect, it } from "vitest";

import { dayItemsFromDecryptedHistory, decryptedHistoryThroughDay,
  DecryptedTimelineChanged, InvalidDecryptedTimeline, projectDecryptedTimeline,
  type DecryptedTimelineEntry } from "./timeline";

const careProfileId = "a".repeat(32);
type FilePrintedDate = Extract<DecryptedTimelineEntry, { kind: "file" }>["printedDate"];
const file = (id: string, careDays: string[], receivedAt: string,
  printedDate: FilePrintedDate = null): DecryptedTimelineEntry => ({
  id, careProfileId, kind: "file", displayName: `fictional-${id.slice(0, 2)}.pdf`,
  receivedAt, careDays, reviewState: "approved", pageNumbers: [1],
  printedDate,
});

const sources: DecryptedTimelineEntry[] = [
  file("1".repeat(32), ["2030-04-12"], "2030-05-01T10:00:00.000Z",
    { kind: "day", value: "2030-04-14" }),
  file("2".repeat(32), ["2030-04-12", "2030-04-09"],
    "2030-04-20T09:00:00.000Z"),
  file("3".repeat(32), ["2030-04-15"], "2030-04-15T12:00:00.000Z"),
  file("4".repeat(32), [], "2030-04-30T12:00:00.000Z",
    { kind: "unclear", originalText: "April 2030" }),
  { id: "5".repeat(32), careProfileId, kind: "family_note",
    body: "Fictional family observation, not a clinical finding.", authorLabel: "Example adult",
    printedDate: null, receivedAt: "2030-04-16T12:00:00.000Z",
    careDays: ["2030-04-12"], reviewState: "approved" },
  { ...file("6".repeat(32), ["2030-04-16"], "2030-04-16T12:00:00.000Z"),
    reviewState: "pending" },
];

describe("client-only decrypted timeline projection", () => {
  it("groups multiple files on one day, leaves gaps and undated items, and keeps three dates distinct", () => {
    const projected = projectDecryptedTimeline(sources, careProfileId);
    expect(projected.days.map(({ day }) => day)).toEqual([
      "2030-04-15", "2030-04-12", "2030-04-09",
    ]);
    expect(projected.days.find(({ day }) => day === "2030-04-12")?.entries).toHaveLength(3);
    expect(projected.undated.map(({ id }) => id)).toEqual(["4".repeat(32)]);
    expect(projected.days.some(({ day }) => day === "2030-04-16")).toBe(false);
    const first = projected.days.find(({ day }) => day === "2030-04-12")!.entries[0]!;
    expect(first.receivedAt).toBe("2030-05-01T10:00:00.000Z");
    expect(first.kind === "file" && first.printedDate).toEqual({
      kind: "day", value: "2030-04-14",
    });
  });

  it("traverses backward by care day, not upload time, and never invents a file URL", async () => {
    const history = await decryptedHistoryThroughDay(sources, careProfileId, "2030-04-12", { limit: 1 });
    expect(history.days.map(({ day }) => day)).toEqual(["2030-04-12"]);
    expect(history.nextCursor?.beforeDay).toBe("2030-04-12");
    expect(history.meaning).toBe("currently_recorded_history");
    const older = await decryptedHistoryThroughDay(sources, careProfileId, "2030-04-12",
      { cursor: history.nextCursor!, limit: 1 });
    expect(older.days.map(({ day }) => day)).toEqual(["2030-04-09"]);
    expect(older.nextCursor).toBeNull();
    const items = dayItemsFromDecryptedHistory(history);
    expect(items[0]?.files).toHaveLength(2);
    expect(items[0]?.files.every((entry) => !("href" in entry))).toBe(true);
    expect(items[0]?.notes[0]?.author).toBe("Example adult");
  });

  it("rebuilds earlier context after a later upload to an earlier care day", async () => {
    const original = await decryptedHistoryThroughDay(sources, careProfileId, "2030-04-09");
    expect(original.days[0]?.entries).toHaveLength(1);
    const late = file("7".repeat(32), ["2030-04-09"], "2030-06-02T11:00:00.000Z");
    const refreshed = await decryptedHistoryThroughDay([...sources, late], careProfileId, "2030-04-09");
    expect(refreshed.days[0]?.entries).toHaveLength(2);
    expect(refreshed.days.some(({ day }) => day > "2030-04-09")).toBe(false);
  });

  it("rejects a stale continuation rather than silently missing an updated day", async () => {
    const first = await decryptedHistoryThroughDay(sources, careProfileId, "2030-04-15", { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const late = file("7".repeat(32), ["2030-04-15"], "2030-06-02T11:00:00.000Z");
    await expect(decryptedHistoryThroughDay([...sources, late], careProfileId, "2030-04-15",
      { cursor: first.nextCursor!, limit: 1 })).rejects.toBeInstanceOf(DecryptedTimelineChanged);
  });

  it("hashes and returns the same copied snapshot despite caller mutation during hashing", async () => {
    const mutable = structuredClone(sources) as DecryptedTimelineEntry[];
    const first = decryptedHistoryThroughDay(mutable, careProfileId, "2030-04-12", { limit: 1 });
    const changed = mutable[0]!;
    if (changed.kind !== "file") throw new Error("Expected fictional file");
    changed.displayName = "changed-after-call.pdf";
    (changed.careDays as string[]).splice(0, 1, "2030-04-10");
    const page = await first;
    const original = page.days[0]!.entries.find((entry) => entry.id === changed.id)!;
    expect(original.kind === "file" && original.displayName).toBe("fictional-11.pdf");
    expect(page.days[0]?.day).toBe("2030-04-12");
    await expect(decryptedHistoryThroughDay(mutable, careProfileId, "2030-04-12",
      { cursor: page.nextCursor! })).rejects.toBeInstanceOf(DecryptedTimelineChanged);
  });

  it("keeps malformed pending material out of approved history", async () => {
    const malformedPending = { ...sources[0]!, id: "8".repeat(32),
      reviewState: "pending" as const, careDays: ["2030-02-30"], receivedAt: "invalid" };
    const projected = projectDecryptedTimeline([...sources, malformedPending], careProfileId);
    expect(projected.days).toHaveLength(3);
    expect((await decryptedHistoryThroughDay([...sources, malformedPending], careProfileId,
      "2030-04-15")).days).toHaveLength(3);
  });

  it("rejects mixed profiles, duplicate IDs, malformed dates, and invalid page bounds", async () => {
    for (const entries of [
      [...sources, { ...sources[0]!, careProfileId: "b".repeat(32), id: "8".repeat(32) }],
      [...sources, sources[0]!],
      [{ ...sources[0]!, careDays: ["2030-02-30"] }],
      [{ ...sources[0]!, receivedAt: "2030-04-12" }],
      [{ ...sources[0]!, pageNumbers: [0] }],
    ]) expect(() => projectDecryptedTimeline(entries, careProfileId))
      .toThrow(InvalidDecryptedTimeline);
    await expect(decryptedHistoryThroughDay(sources, careProfileId, "2030-02-30"))
      .rejects.toBeInstanceOf(InvalidDecryptedTimeline);
  });
});
