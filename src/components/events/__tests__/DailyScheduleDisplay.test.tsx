/**
 * OPE-47 (2026-07): the "Daily:" simplified label must reflect ACTUAL date
 * contiguity, not the `discontinuous_dates` flag. These render tests guard the
 * three cases the fix cares about:
 *   - a recurring (every-Saturday) market with discontinuous_dates=false must
 *     NOT show "Daily" — it routes to the cadence view ("Every Saturday …");
 *   - a genuinely-daily contiguous multi-day run still shows "Daily:";
 *   - a single-day event is unchanged ("Daily:").
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DailyScheduleDisplay } from "../DailyScheduleDisplay";
import type { EventDay } from "@/types";

const day = (date: string, extra: Partial<EventDay> = {}): EventDay =>
  ({
    id: date,
    date,
    openTime: "09:00",
    closeTime: "17:00",
    closed: false,
    vendorOnly: false,
    ...extra,
  }) as EventDay;

describe("DailyScheduleDisplay — contiguity gate on the 'Daily:' label", () => {
  it("does NOT render 'Daily' for a Saturdays-only market (discontinuous_dates=false)", () => {
    const days = [day("2026-06-06"), day("2026-06-13"), day("2026-06-20")];
    const { container } = render(<DailyScheduleDisplay days={days} discontinuousDates={false} />);

    expect(container.textContent).not.toMatch(/Daily:/i);
    // Routed to the cadence view instead.
    expect(container.textContent).toMatch(/Every Saturday/i);
  });

  it("renders 'Daily:' for a genuinely contiguous multi-day run with same hours", () => {
    const days = [day("2026-07-04"), day("2026-07-05"), day("2026-07-06")];
    const { container } = render(<DailyScheduleDisplay days={days} discontinuousDates={false} />);

    expect(container.textContent).toMatch(/Daily:/i);
    expect(container.textContent).not.toMatch(/Every /i);
  });

  it("renders 'Daily:' for a single-day event (unchanged)", () => {
    const { container } = render(
      <DailyScheduleDisplay days={[day("2026-07-04")]} discontinuousDates={false} />
    );
    expect(container.textContent).toMatch(/Daily:/i);
  });

  it("still routes an explicitly-flagged contiguous event to the cadence view", () => {
    // discontinuous_dates=true must always suppress "Daily:" even when the
    // stored dates happen to look contiguous.
    const days = [day("2026-07-04"), day("2026-07-05"), day("2026-07-06")];
    const { container } = render(<DailyScheduleDisplay days={days} discontinuousDates={true} />);
    expect(container.textContent).not.toMatch(/Daily:/i);
  });
});
