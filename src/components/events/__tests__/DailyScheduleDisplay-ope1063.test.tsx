/**
 * OPE-1063 — the collapsed one-line "Daily: …" summary has no slot for a
 * per-day note, so it silently discarded every day's PUBLIC `notes`. The
 * specimen was /events/new-portland-lions-fair/2026: four contiguous days, all
 * hours NULL, four visitor-facing notes, rendered as one line
 * "Daily: Hours not yet confirmed".
 *
 * Rule: the collapse is allowed only when no visible open day has a note.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DailyScheduleDisplay } from "../DailyScheduleDisplay";
import type { EventDay } from "@/types";

const day = (date: string, extra: Partial<EventDay> = {}): EventDay =>
  ({
    id: date,
    date,
    openTime: null,
    closeTime: null,
    closed: false,
    vendorOnly: false,
    notes: null,
    ...extra,
  }) as EventDay;

const NEW_PORTLAND = [
  day("2026-09-17", {
    notes: "Opening night — second annual cornhole tournament. Beer garden open.",
  }),
  day("2026-09-18", { notes: "Truck pulls with street class." }),
  day("2026-09-19", { notes: "Dirty McCurdy Band, lawn mower races and the mud run." }),
  day("2026-09-20", {
    notes: "Kids Day — mutton busting, pig scramble and the demolition derby.",
  }),
];

const text = (days: EventDay[]) =>
  render(<DailyScheduleDisplay days={days} discontinuousDates={false} />).container.textContent ??
  "";

describe("DailyScheduleDisplay — OPE-1063 day notes survive unknown hours", () => {
  it("renders every note on the all-hours-unknown specimen", () => {
    const t = text(NEW_PORTLAND);
    for (const d of NEW_PORTLAND) expect(t).toContain(d.notes!);
    expect(t).not.toContain("Daily:");
  });

  it("an unknown-hours day with a note reads 'Hours not yet confirmed — <note>'", () => {
    const t = text(NEW_PORTLAND);
    expect(t).toContain("Thu, Sep 17, 2026:");
    expect(t).toContain(
      "Hours not yet confirmed — Opening night — second annual cornhole tournament."
    );
  });

  it("a single note on one day is enough to break the collapse", () => {
    const days = [day("2026-09-17"), day("2026-09-18", { notes: "Truck pulls." })];
    const t = text(days);
    expect(t).toContain("Hours not yet confirmed — Truck pulls.");
    expect(t).not.toContain("Daily:");
  });

  it("keeps the collapsed 'Daily:' line when every day has null hours AND no note", () => {
    const days = [day("2026-09-17"), day("2026-09-18", { notes: "   " })];
    expect(text(days)).toContain("Daily: Hours not yet confirmed");
  });

  it("uniform KNOWN hours with a note also keep the note (same collapse path)", () => {
    const days = [
      day("2026-10-10", { openTime: "10:00", closeTime: "16:00", notes: "Saturday" }),
      day("2026-10-11", { openTime: "10:00", closeTime: "16:00", notes: "Sunday — final day" }),
    ];
    const t = text(days);
    expect(t).toContain("Open 10am - 4pm");
    expect(t).toContain("(Saturday)");
    expect(t).toContain("(Sunday — final day)");
    expect(t).not.toContain("Daily:");
  });

  describe("single-day events stay one readable line", () => {
    it("known hours + note: '<date>: 10am - 4pm (note)', no one-row 'Dates:' list", () => {
      const t = text([
        day("2026-10-10", { openTime: "10:00", closeTime: "16:00", notes: "Rain or shine." }),
      ]);
      expect(t).toBe("Sat, Oct 10, 2026: 10am - 4pm (Rain or shine.)");
    });

    it("unknown hours + note: '<date>: Hours not yet confirmed — note'", () => {
      const t = text([day("2026-10-17", { notes: "Saturday — single-day festival." })]);
      expect(t).toBe(
        "Sat, Oct 17, 2026: Hours not yet confirmed — Saturday — single-day festival."
      );
    });

    it("no note: unchanged 'Daily:' line", () => {
      const t = text([day("2026-10-10", { openTime: "10:00", closeTime: "16:00" })]);
      expect(t).toBe("Daily: 10am - 4pm");
    });

    it("a lone vendor-only day shown with badges keeps the list view (badge survives)", () => {
      const { container } = render(
        <DailyScheduleDisplay
          days={[
            day("2026-10-10", {
              openTime: "07:00",
              closeTime: "09:00",
              vendorOnly: true,
              notes: "Load-in",
            }),
          ]}
          showVendorDays="badge"
        />
      );
      expect(container.textContent).toContain("Vendor Setup");
      expect(container.textContent).toContain("(Load-in)");
    });
  });

  it("uniform known hours with NO notes still collapse to 'Daily:'", () => {
    const days = [
      day("2026-10-10", { openTime: "10:00", closeTime: "16:00" }),
      day("2026-10-11", { openTime: "10:00", closeTime: "16:00" }),
    ];
    expect(text(days)).toContain("Daily: 10am - 4pm");
  });
});
