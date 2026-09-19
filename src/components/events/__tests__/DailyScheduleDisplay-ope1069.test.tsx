/**
 * OPE-1069 — a day whose close time the organizer does not publish says so,
 * instead of rendering a bare opening time the visitor cannot tell from
 * missing data. The unknown case keeps its old rendering — a pair, so a
 * renderer that says "no published closing time" everywhere cannot pass.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DailyScheduleDisplay } from "../DailyScheduleDisplay";
import type { EventDay } from "@/types";

const day = (date: string, extra: Partial<EventDay> = {}): EventDay =>
  ({
    id: date,
    date,
    openTime: "08:00",
    closeTime: null,
    closed: false,
    vendorOnly: false,
    ...extra,
  }) as EventDay;

describe("DailyScheduleDisplay — OPE-1069", () => {
  it("says the organizer publishes no closing time when that is the finding", () => {
    const days = [
      day("2026-09-18", { closeTimeUnpublished: 1 }),
      day("2026-09-19", { closeTimeUnpublished: 1 }),
    ];
    const { container } = render(<DailyScheduleDisplay days={days} discontinuousDates={false} />);
    expect(container.textContent).toContain("Opens 8am (no published closing time)");
  });

  it("an open-only day that is merely unknown does NOT claim the organizer is silent", () => {
    const days = [day("2026-09-18"), day("2026-09-19")];
    const { container } = render(<DailyScheduleDisplay days={days} discontinuousDates={false} />);
    // Landmark: the opening time rendered, so the absence below is a decision.
    expect(container.textContent).toContain("8am");
    expect(container.textContent).not.toContain("no published closing time");
  });
});
