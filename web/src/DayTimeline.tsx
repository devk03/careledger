import { FileText, StickyNote } from "lucide-react";

import "./day-timeline.css";

export type DayTimelineItem = {
  id: string;
  day: string;
  files: readonly { id: string; name: string; href?: string }[];
  notes: readonly { id: string; text: string; author: string }[];
};

function formattedDay(day: string): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

/** A sparse, day-level view. No empty dates or inferred events are rendered. */
export function DayTimeline({
  days,
  undatedCount = 0,
}: {
  days: readonly DayTimelineItem[];
  undatedCount?: number;
}) {
  const ordered = [...days].sort((left, right) => right.day.localeCompare(left.day));

  return (
    <section className="day-timeline" aria-labelledby="day-timeline-title">
      <div className="day-timeline-intro">
        <p className="section-note">Record history</p>
        <h2 id="day-timeline-title">One day at a time.</h2>
        <p>Only days with recorded files or notes appear. A gap does not mean nothing happened.</p>
      </div>

      {ordered.length === 0 ? (
        <p className="day-timeline-empty">No dated records yet. Files without a clear care day stay in “Date unclear.”</p>
      ) : (
        <ol className="day-timeline-list">
          {ordered.map((item) => (
            <li key={item.id}>
              <details className="day-timeline-card">
                <summary>
                  <span className="day-timeline-date"><time dateTime={item.day}>{formattedDay(item.day)}</time></span>
                  <span className="day-timeline-counts">
                    {item.files.length} {item.files.length === 1 ? "file" : "files"}
                    {item.notes.length > 0 ? ` · ${item.notes.length} ${item.notes.length === 1 ? "note" : "notes"}` : ""}
                  </span>
                  <span className="day-timeline-expand" aria-hidden="true">
                    <span className="day-timeline-expand-closed">View sources</span>
                    <span className="day-timeline-expand-open">Hide sources</span>
                  </span>
                </summary>
                <div className="day-timeline-content">
                  {item.files.length > 0 ? (
                    <div>
                      <h3>Files for this day</h3>
                      <ul>
                        {item.files.map((file) => (
                          <li key={file.id}>
                            <FileText size={17} aria-hidden="true" />
                            {file.href ? <a href={file.href}>{file.name}</a> : <span>{file.name}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {item.notes.length > 0 ? (
                    <div>
                      <h3>Family notes</h3>
                      <ul>
                        {item.notes.map((note) => (
                          <li key={note.id}>
                            <StickyNote size={17} aria-hidden="true" />
                            <span>{note.text} <small>— {note.author}</small></span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}

      {undatedCount > 0 ? (
        <p className="day-timeline-undated">Date unclear: {undatedCount} {undatedCount === 1 ? "item needs" : "items need"} a care day before appearing here.</p>
      ) : null}
    </section>
  );
}
