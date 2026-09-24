import type { HistoryPage, TimelineDayIndexPage } from "@adeno/contracts";

import type { DayTimelineItem } from "../DayTimeline";

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`Timeline request failed: ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchTimelineDays(careProfileId: string, throughDay: string): Promise<TimelineDayIndexPage> {
  const base = `/api/v2/care-profiles/${encodeURIComponent(careProfileId)}/timeline/days`;
  return readJson<TimelineDayIndexPage>(`${base}?through=${encodeURIComponent(throughDay)}`);
}

export async function fetchHistoryThroughDay(
  careProfileId: string,
  throughDay: string,
  focusFromDay?: string,
): Promise<HistoryPage> {
  const base = `/api/v2/care-profiles/${encodeURIComponent(careProfileId)}/timeline/history`;
  const query = new URLSearchParams({ through: throughDay });
  if (focusFromDay) query.set("from", focusFromDay);
  return readJson<HistoryPage>(`${base}?${query}`);
}

/** View model only; no inferred day, clinical event or summary is added. */
export function dayItemsFromHistory(history: HistoryPage): DayTimelineItem[] {
  return history.days.map((day) => ({
    id: day.id,
    day: day.day,
    files: day.sources.map((source) => ({ id: source.documentId, name: source.displayName })),
    notes: day.statements
      .filter((statement) => statement.attribution === "family_note")
      .map((statement) => ({
        id: statement.id,
        text: statement.text,
        author: statement.authorLabel ?? "Family note",
      })),
  }));
}
