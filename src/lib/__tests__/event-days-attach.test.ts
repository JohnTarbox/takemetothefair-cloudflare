import { describe, it, expect, vi } from "vitest";
import { attachEventDayDates } from "../event-days-attach";

describe("attachEventDayDates", () => {
  it("returns an empty array immediately when input is empty (no DB call)", async () => {
    const db = {
      select: vi.fn(),
    } as unknown;
    const result = await attachEventDayDates(db as never, []);
    expect(result).toEqual([]);
    expect((db as { select: () => unknown }).select).not.toHaveBeenCalled();
  });

  it("attaches sorted event_days to each event", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { eventId: "e1", date: "2026-06-20" },
            { eventId: "e1", date: "2026-06-13" },
            { eventId: "e2", date: "2026-07-04" },
          ]),
        }),
      }),
    } as unknown;
    const result = await attachEventDayDates(db as never, [
      { id: "e1", name: "Market" },
      { id: "e2", name: "Festival" },
      { id: "e3", name: "Empty" },
    ]);
    // Sorted ascending; e3 gets [] since no rows came back for it.
    expect(result[0].eventDayDates).toEqual(["2026-06-13", "2026-06-20"]);
    expect(result[1].eventDayDates).toEqual(["2026-07-04"]);
    expect(result[2].eventDayDates).toEqual([]);
    // Original fields preserved.
    expect(result[0].name).toBe("Market");
  });

  it("batches in chunks of 50 for D1 100-param cap", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
    } as unknown;
    // 120 events → 3 batches of 50/50/20.
    const events = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}` }));
    await attachEventDayDates(db as never, events);
    expect(where).toHaveBeenCalledTimes(3);
  });
});
