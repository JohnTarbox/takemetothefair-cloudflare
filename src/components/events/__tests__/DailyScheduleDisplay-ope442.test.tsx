/**
 * OPE-442 — the date column collided with the notes column.
 *
 * The date cell was `w-28` (7rem), narrower than "Thu, Aug 13, 2026:". The date
 * wrapped onto four lines and its final fragment ran straight into the note
 * text with no separating space:
 *
 *     Thu,  10am - 11pm  (Fairgrounds 10 AM to 11 PM.
 *     Aug   Carnival opens at 11 AM. Hall opens in the
 *     13,   afternoon and closes at 10 PM; Barn closes
 *     2026:at 9 PM; Fiber Tent closes at 5 PM.)
 *
 * `2026:at 9 PM` reads as corrupted data, not a layout bug — the worst kind of
 * visual defect on a page whose value proposition is trustworthy fair data.
 *
 * jsdom does not lay out, so these assert the CAUSE rather than the pixels: the
 * date cell must be non-wrapping, non-shrinking, and padded away from what
 * follows. That is the property that makes the collision impossible, and it is
 * what a future refactor would otherwise silently drop.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DailyScheduleDisplay } from "../DailyScheduleDisplay";
import type { EventDay } from "@/types";

const day = (date: string, close: string, notes?: string): EventDay =>
  ({
    id: date,
    date,
    openTime: "10:00",
    closeTime: close,
    closed: false,
    vendorOnly: false,
    notes,
  }) as EventDay;

/**
 * The reported event: a 4-day contiguous fair with long per-day notes.
 *
 * Closing times DIFFER per day, which is what the real Martha's Vineyard Fair
 * looks like and what forces the per-day list to render. An earlier version of
 * this fixture gave every day identical hours and the component collapsed to
 * "Daily: 10am - 11pm" — no date cells at all, so the collision this file
 * exists to guard was not on screen to guard.
 */
const MV_DAYS = [
  day(
    "2026-08-13",
    "23:00",
    "Carnival opens at 11 AM; Barn closes at 9 PM; Fiber Tent closes at 5 PM."
  ),
  day("2026-08-14", "22:00", "Carnival opens at 11 AM; Barn closes at 9 PM."),
  day("2026-08-15", "22:00", "Carnival opens at 11 AM."),
  day("2026-08-16", "18:00", "Closes at 6 PM."),
];

function dateCells(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("span")).filter((el) =>
    /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(el.textContent ?? "")
  ) as HTMLElement[];
}

describe("the date cell cannot wrap into the notes column", () => {
  it("renders the reported 4-day fair with per-day notes", () => {
    const { container } = render(
      <DailyScheduleDisplay days={MV_DAYS} discontinuousDates={false} />
    );
    expect(dateCells(container).length).toBeGreaterThan(0);
  });

  it("every date cell is whitespace-nowrap — the wrap IS the collision", () => {
    const { container } = render(
      <DailyScheduleDisplay days={MV_DAYS} discontinuousDates={false} />
    );
    for (const cell of dateCells(container)) {
      expect(cell.className, cell.textContent ?? "").toContain("whitespace-nowrap");
    }
  });

  it("every date cell is shrink-0 and padded from what follows", () => {
    // shrink-0: flex must not squeeze the cell back below its content.
    // pr-3: guarantees a gap even at the narrowest viewport, so the failure
    // mode degrades to "tight" rather than "2026:at 9 PM".
    const { container } = render(
      <DailyScheduleDisplay days={MV_DAYS} discontinuousDates={false} />
    );
    for (const cell of dateCells(container)) {
      expect(cell.className).toContain("shrink-0");
      expect(cell.className).toContain("pr-3");
    }
  });

  it("no longer pins the cell to a fixed w-28", () => {
    // The fixed width was the proximate cause. `min-w-` preserves column
    // alignment for short dates without forcing long ones to wrap.
    const { container } = render(
      <DailyScheduleDisplay days={MV_DAYS} discontinuousDates={false} />
    );
    for (const cell of dateCells(container)) {
      expect(cell.className.split(/\s+/)).not.toContain("w-28");
    }
  });
});

describe("the notes still render", () => {
  it("keeps the note text intact next to the date", () => {
    // Guards the lazy fix: truncating or dropping notes would also stop the
    // collision, and would be worse than the bug.
    const { container } = render(
      <DailyScheduleDisplay days={MV_DAYS} discontinuousDates={false} />
    );
    expect(container.textContent).toContain("Fiber Tent closes at 5 PM.");
  });
});
