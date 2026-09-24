import { describe, expect, it } from "vitest";

import {
  getHistoryThroughDay,
  InvalidTimelineDate,
  TimelineAccessDenied,
} from "../src/timeline/history.js";
import type { TimelineDay, TimelineRepository } from "../src/timeline/types.js";

const scope = { householdId: "family-a", userId: "adult-a" };

function day(value: string, documentId: string): TimelineDay {
  return {
    id: `day-${value}`,
    careProfileId: "person-a",
    day: value,
    sources: [{
      documentId,
      displayName: `${documentId}.pdf`,
      uploadedAt: "2026-09-20T12:00:00Z",
      sourceSha256: "a".repeat(64),
      pageNumbers: [1],
    }],
    statements: [{
      id: `statement-${documentId}`,
      text: "Fictional test record states a visit occurred.",
      attribution: "document",
      status: "occurred",
      sourceDocumentId: documentId,
      pageNumber: 1,
    }],
    revision: 1,
  };
}

class FictionalRepository implements TimelineRepository {
  days: TimelineDay[] = [day("2026-09-18", "report-b"), day("2026-09-15", "report-a")];
  listCalls = 0;

  async profileBelongsToHousehold(profile: string, household: string): Promise<boolean> {
    return profile === "person-a" && household === "family-a";
  }

  async listApprovedDays(input: {
    householdId: string;
    userId: string;
    careProfileId: string;
    throughDay: string;
    beforeDay?: string;
    limit: number;
  }): Promise<TimelineDay[]> {
    this.listCalls += 1;
    if (input.householdId !== "family-a" || input.userId !== "adult-a" ||
      input.careProfileId !== "person-a") {
      throw new Error("Unscoped repository request");
    }
    return this.days
      .filter((entry) => entry.day <= input.throughDay &&
        (input.beforeDay === undefined || entry.day < input.beforeDay))
      .sort((left, right) => right.day.localeCompare(left.day))
      .slice(0, input.limit);
  }
}

describe("backward timeline traversal", () => {
  it("starts with the selected day, skips empty days and excludes future care days", async () => {
    const repository = new FictionalRepository();
    const history = await getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a",
      throughDay: "2026-09-17",
    });
    expect(history.days.map((entry) => entry.day)).toEqual(["2026-09-15"]);
    expect(history.meaning).toBe("currently_recorded_history");
    expect(history.focusFromDay).toBeNull();
  });

  it("labels a requested range while still returning earlier context", async () => {
    const repository = new FictionalRepository();
    const history = await getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a",
      focusFromDay: "2026-09-17",
      throughDay: "2026-09-18",
    });
    expect(history.focusFromDay).toBe("2026-09-17");
    expect(history.days.map((entry) => entry.day)).toEqual(["2026-09-18", "2026-09-15"]);
  });

  it("reads again on each query, including a later upload assigned to an earlier day", async () => {
    const repository = new FictionalRepository();
    const query = { careProfileId: "person-a", throughDay: "2026-09-18" };
    await getHistoryThroughDay(repository, scope, query);
    repository.days[1]?.sources.push({
      documentId: "late-upload",
      displayName: "late-upload.pdf",
      uploadedAt: "2026-09-23T09:00:00Z",
      sourceSha256: "b".repeat(64),
      pageNumbers: [2],
    });
    const refreshed = await getHistoryThroughDay(repository, scope, query);
    expect(repository.listCalls).toBe(2);
    expect(refreshed.days.find((entry) => entry.day === "2026-09-15")?.sources).toHaveLength(2);
  });

  it("paginates toward earlier days without inventing empty nodes", async () => {
    const repository = new FictionalRepository();
    const first = await getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a", throughDay: "2026-09-18", limit: 1,
    });
    expect(first.days.map((entry) => entry.day)).toEqual(["2026-09-18"]);
    expect(first.nextBeforeDay).toBe("2026-09-18");
    const second = await getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a", throughDay: "2026-09-18", beforeDay: first.nextBeforeDay!, limit: 1,
    });
    expect(second.days.map((entry) => entry.day)).toEqual(["2026-09-15"]);
    expect(second.nextBeforeDay).toBeNull();
  });

  it("denies another family without querying their timeline", async () => {
    const repository = new FictionalRepository();
    await expect(getHistoryThroughDay(repository, { householdId: "family-b", userId: "adult-b" }, {
      careProfileId: "person-a", throughDay: "2026-09-18",
    })).rejects.toBeInstanceOf(TimelineAccessDenied);
    expect(repository.listCalls).toBe(0);
  });

  it("rejects malformed dates and invalid cursors", async () => {
    const repository = new FictionalRepository();
    await expect(getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a", throughDay: "2026-02-30",
    })).rejects.toBeInstanceOf(InvalidTimelineDate);
    await expect(getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a", throughDay: "2026-09-18", beforeDay: "2026-09-19",
    })).rejects.toBeInstanceOf(InvalidTimelineDate);
    await expect(getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a", throughDay: "2026-09-18", focusFromDay: "2026-09-19",
    })).rejects.toBeInstanceOf(InvalidTimelineDate);
  });

  it("fails closed if an adapter returns a day from another profile", async () => {
    const repository = new FictionalRepository();
    repository.days[0] = { ...repository.days[0]!, careProfileId: "person-b" };
    await expect(getHistoryThroughDay(repository, scope, {
      careProfileId: "person-a", throughDay: "2026-09-18",
    })).rejects.toThrow("out-of-scope");
  });
});
