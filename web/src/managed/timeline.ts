import type { DayTimelineItem } from "../DayTimeline";

type PrintedDate =
  | { kind: "day"; value: string }
  | { kind: "unclear"; originalText: string }
  | null;

type CommonEntry = {
  id: string;
  careProfileId: string;
  receivedAt: string;
  careDays: readonly string[];
  reviewState: "approved" | "pending";
};

/** Plaintext on an authorized device only. Never use as a hosted API wire type. */
export type DecryptedTimelineEntry = CommonEntry & (
  | { kind: "file"; displayName: string; printedDate: PrintedDate;
      pageNumbers: readonly number[] }
  | { kind: "family_note"; body: string; authorLabel: string;
      printedDate: null }
);

export type DecryptedCareDay = { day: string; entries: DecryptedTimelineEntry[] };
export type DecryptedTimeline = {
  careProfileId: string;
  days: DecryptedCareDay[];
  undated: DecryptedTimelineEntry[];
};

export type DecryptedHistoryPage = {
  careProfileId: string;
  throughDay: string;
  days: DecryptedCareDay[];
  nextCursor: DecryptedHistoryCursor | null;
  meaning: "currently_recorded_history";
};

export type DecryptedHistoryCursor = {
  careProfileId: string;
  throughDay: string;
  beforeDay: string;
  fingerprint: string;
};

export class InvalidDecryptedTimeline extends Error {
  constructor() { super("The decrypted timeline entry is invalid."); }
}

export class DecryptedTimelineChanged extends Error {
  constructor() { super("The recorded history changed. Start again from the latest day."); }
}

/**
 * Client-side view only. Callers must first authenticate/decrypt only sources
 * permitted by current grants. This function cannot enforce family access.
 */
export function projectDecryptedTimeline(
  entries: readonly DecryptedTimelineEntry[],
  careProfileId: string,
): DecryptedTimeline {
  return projectSnapshot(snapshotApprovedEntries(entries, careProfileId), careProfileId);
}

function snapshotApprovedEntries(entries: readonly DecryptedTimelineEntry[],
  careProfileId: string): DecryptedTimelineEntry[] {
  if (!/^[0-9a-f]{32}$/u.test(careProfileId)) throw new InvalidDecryptedTimeline();
  const approved: DecryptedTimelineEntry[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    // Pending submissions belong to a separate reviewer inbox. A malformed
    // pending draft must not take down the approved history for other members.
    if (entry?.reviewState === "pending") continue;
    validateEntry(entry);
    if (entry.careProfileId !== careProfileId) throw new InvalidDecryptedTimeline();
    if (ids.has(entry.id)) throw new InvalidDecryptedTimeline();
    ids.add(entry.id);
    const common = { id: entry.id, careProfileId, receivedAt: entry.receivedAt,
      careDays: [...entry.careDays], reviewState: "approved" as const };
    approved.push(entry.kind === "file" ? {
      ...common, kind: "file", displayName: entry.displayName,
      printedDate: entry.printedDate === null ? null : { ...entry.printedDate },
      pageNumbers: [...entry.pageNumbers],
    } : { ...common, kind: "family_note", body: entry.body,
      authorLabel: entry.authorLabel, printedDate: null });
  }
  return approved;
}

function projectSnapshot(entries: readonly DecryptedTimelineEntry[],
  careProfileId: string): DecryptedTimeline {
  const byDay = new Map<string, DecryptedTimelineEntry[]>();
  const undated: DecryptedTimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.careDays.length === 0) {
      undated.push(entry);
      continue;
    }
    for (const day of entry.careDays) {
      const current = byDay.get(day) ?? [];
      current.push(entry);
      byDay.set(day, current);
    }
  }
  return {
    careProfileId,
    days: [...byDay.entries()].sort(([left], [right]) => right.localeCompare(left))
      .map(([day, dayEntries]) => ({ day, entries: dayEntries })),
    undated,
  };
}

/** Inclusive care-day cutoff, independent of when a source was uploaded. */
export async function decryptedHistoryThroughDay(
  entries: readonly DecryptedTimelineEntry[],
  careProfileId: string,
  throughDay: string,
  input: { cursor?: DecryptedHistoryCursor; limit?: number } = {},
): Promise<DecryptedHistoryPage> {
  const snapshot = snapshotApprovedEntries(entries, careProfileId);
  const timeline = projectSnapshot(snapshot, careProfileId);
  assertDay(throughDay);
  const fingerprint = await approvedFingerprint(snapshot);
  const cursor = input.cursor;
  if (cursor !== undefined && (cursor.careProfileId !== careProfileId ||
    cursor.throughDay !== throughDay || cursor.fingerprint !== fingerprint))
    throw new DecryptedTimelineChanged();
  if (cursor !== undefined) assertDay(cursor.beforeDay);
  if (cursor !== undefined && cursor.beforeDay > throughDay)
    throw new InvalidDecryptedTimeline();
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new InvalidDecryptedTimeline();
  const visible = timeline.days.filter(({ day }) => day <= throughDay &&
    (cursor === undefined || day < cursor.beforeDay));
  const days = visible.slice(0, limit);
  return { careProfileId, throughDay, days,
    nextCursor: visible.length > limit ? {
      careProfileId, throughDay, beforeDay: days.at(-1)!.day, fingerprint,
    } : null,
    meaning: "currently_recorded_history" };
}

async function approvedFingerprint(entries: readonly DecryptedTimelineEntry[]): Promise<string> {
  const canonical = [...entries].sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => ({
      id: entry.id, careProfileId: entry.careProfileId,
      kind: entry.kind, receivedAt: entry.receivedAt,
      careDays: [...entry.careDays].sort(),
      ...(entry.kind === "file" ? {
        displayName: entry.displayName, printedDate: entry.printedDate,
        pageNumbers: [...entry.pageNumbers],
      } : { body: entry.body, authorLabel: entry.authorLabel }),
    }));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** No original-file URL is produced until a separate source grant is checked. */
export function dayItemsFromDecryptedHistory(
  history: DecryptedHistoryPage,
): DayTimelineItem[] {
  return history.days.map(({ day, entries }) => ({
    id: day,
    day,
    files: entries.filter((entry) => entry.kind === "file")
      .map((entry) => ({ id: entry.id, name: entry.displayName })),
    notes: entries.filter((entry) => entry.kind === "family_note")
      .map((entry) => ({ id: entry.id, text: entry.body, author: entry.authorLabel })),
  }));
}

function validateEntry(entry: DecryptedTimelineEntry): void {
  if (!entry || !/^[0-9a-f]{32}$/u.test(entry.id) ||
    !/^[0-9a-f]{32}$/u.test(entry.careProfileId) ||
    !validTimestamp(entry.receivedAt) || !Array.isArray(entry.careDays) ||
    entry.careDays.length > 366 ||
    (entry.reviewState !== "approved" && entry.reviewState !== "pending"))
    throw new InvalidDecryptedTimeline();
  const dates = new Set<string>();
  for (const day of entry.careDays) {
    assertDay(day);
    if (dates.has(day)) throw new InvalidDecryptedTimeline();
    dates.add(day);
  }
  if (entry.kind === "file") {
    if (!visibleText(entry.displayName, 256) || !Array.isArray(entry.pageNumbers) ||
      entry.pageNumbers.length > 1000 || entry.pageNumbers.some((page) =>
        !Number.isSafeInteger(page) || page < 1 || page > 10_000))
      throw new InvalidDecryptedTimeline();
    if (entry.printedDate?.kind === "day") assertDay(entry.printedDate.value);
    else if (entry.printedDate?.kind === "unclear") {
      if (!visibleText(entry.printedDate.originalText, 256))
        throw new InvalidDecryptedTimeline();
    } else if (entry.printedDate !== null) throw new InvalidDecryptedTimeline();
  } else if (entry.kind === "family_note") {
    if (!visibleText(entry.body, 20_000) || !visibleText(entry.authorLabel, 256) ||
      entry.printedDate !== null) throw new InvalidDecryptedTimeline();
  } else throw new InvalidDecryptedTimeline();
}

function assertDay(value: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new InvalidDecryptedTimeline();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new InvalidDecryptedTimeline();
}

function validTimestamp(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function visibleText(value: string, maximum: number): boolean {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximum && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
    });
}
