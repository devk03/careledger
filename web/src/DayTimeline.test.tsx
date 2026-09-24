import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DayTimeline } from "./DayTimeline";

const fictionalDays = [
  {
    id: "day-a",
    day: "2030-04-12",
    files: [
      { id: "file-a", name: "fictional-visit.pdf", href: "/fictional-source-a" },
      { id: "file-b", name: "fictional-lab.pdf", href: "/fictional-source-b" },
    ],
    notes: [{ id: "note-a", text: "Family wrote down questions after the sample visit.", author: "Example adult" }],
  },
  {
    id: "day-b",
    day: "2030-04-09",
    files: [{ id: "file-c", name: "fictional-referral.pdf" }],
    notes: [],
  },
];

describe("DayTimeline", () => {
  it("shows only populated days and allows multiple files on one day", () => {
    render(<DayTimeline days={fictionalDays} undatedCount={1} />);
    const dates = screen.getAllByText(/April \d+, 2030/).map((node) => node.textContent);
    expect(dates).toEqual(["Friday, April 12, 2030", "Tuesday, April 9, 2030"]);
    expect(screen.queryByText(/April 10, 2030/)).not.toBeInTheDocument();
    expect(screen.getByText("2 files · 1 note")).toBeInTheDocument();
    expect(screen.getByText(/Date unclear: 1 item needs/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Friday, April 12, 2030"));
    const card = screen.getByText("Friday, April 12, 2030").closest("details");
    expect(card).not.toBeNull();
    expect(within(card!).getByRole("link", { name: "fictional-visit.pdf" })).toHaveAttribute("href", "/fictional-source-a");
    expect(within(card!).getByRole("link", { name: "fictional-lab.pdf" })).toHaveAttribute("href", "/fictional-source-b");
  });

  it("does not create blank day cards for an empty timeline", () => {
    render(<DayTimeline days={[]} />);
    expect(screen.getByText(/No dated records yet/)).toBeInTheDocument();
    expect(screen.queryByText(/View sources/)).not.toBeInTheDocument();
  });
});
