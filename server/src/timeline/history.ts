import type {
  AuthorizedScope,
  HistoryPage,
  ISODate,
  TimelineRepository,
  TimelineDayIndexPage,
} from "./types.js";

export class TimelineAccessDenied extends Error {
  constructor() {
    super("Timeline not found");
  }
}

export class InvalidTimelineDate extends Error {
  constructor() {
    super("Expected a valid YYYY-MM-DD calendar date");
  }
}

export function parseISODate(value: string): ISODate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidTimelineDate();
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InvalidTimelineDate();
  }
  return value;
}

/** Read approved records afresh on each request; no cached clinical consensus. */
export async function getHistoryThroughDay(
  repository: TimelineRepository,
  scope: AuthorizedScope,
  input: {
    careProfileId: string;
    throughDay: string;
    focusFromDay?: string;
    beforeDay?: string;
    limit?: number;
  },
): Promise<HistoryPage> {
  const throughDay = parseISODate(input.throughDay);
  const focusFromDay = input.focusFromDay === undefined ? null : parseISODate(input.focusFromDay);
  const beforeDay = input.beforeDay === undefined ? undefined : parseISODate(input.beforeDay);
  if (focusFromDay !== null && focusFromDay > throughDay) {
    throw new InvalidTimelineDate();
  }
  if (beforeDay !== undefined && beforeDay > throughDay) {
    throw new InvalidTimelineDate();
  }
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("History limit must be between 1 and 50");
  }

  if (!(await repository.profileBelongsToHousehold(input.careProfileId, scope.householdId))) {
    throw new TimelineAccessDenied();
  }

  // Fetch one extra day to decide whether a continuation cursor is needed.
  const rows = await repository.listApprovedDays({
    householdId: scope.householdId,
    userId: scope.userId,
    careProfileId: input.careProfileId,
    throughDay,
    ...(beforeDay === undefined ? {} : { beforeDay }),
    limit: limit + 1,
  });
  if (rows.some((day) => day.careProfileId !== input.careProfileId || day.day > throughDay ||
    (beforeDay !== undefined && day.day >= beforeDay))) {
    throw new Error("Timeline repository returned out-of-scope data");
  }
  const days = rows.slice(0, limit);
  return {
    throughDay,
    focusFromDay,
    days,
    nextBeforeDay: rows.length > limit ? days.at(-1)?.day ?? null : null,
    meaning: "currently_recorded_history",
  };
}

export async function listTimelineDays(
  repository: TimelineRepository,
  scope: AuthorizedScope,
  input: {
    careProfileId: string;
    throughDay: string;
    beforeDay?: string;
    limit?: number;
  },
): Promise<TimelineDayIndexPage> {
  const history = await getHistoryThroughDay(repository, scope, input);
  return {
    throughDay: history.throughDay,
    days: history.days.map((day) => ({
      id: day.id,
      day: day.day,
      fileCount: day.sources.length,
      revision: day.revision,
    })),
    nextBeforeDay: history.nextBeforeDay,
  };
}
