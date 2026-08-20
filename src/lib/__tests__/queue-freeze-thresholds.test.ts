import { describe, expect, it, vi } from "vitest";
import {
  FROZEN_DAYS_KEY,
  SLOW_DRAIN_RATIO_KEY,
  loadQueueFreezeThresholds,
} from "@/lib/queue-freeze-thresholds";

/** Minimal db stub: select().from().where() resolves to `rows`. */
function dbReturning(rows: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  } as never;
}

function dbThrowing() {
  return {
    select: () => {
      throw new Error("D1_ERROR: no such table: tunable_thresholds");
    },
  } as never;
}

describe("loadQueueFreezeThresholds (OPE-497)", () => {
  it("reads both keys when present", async () => {
    const t = await loadQueueFreezeThresholds(
      dbReturning([
        { key: FROZEN_DAYS_KEY, value: 14 },
        { key: SLOW_DRAIN_RATIO_KEY, value: 0.25 },
      ])
    );
    expect(t).toEqual({ frozenZeroOutflowDays: 14, slowDrainRatio: 0.25 });
  });

  it("leaves a missing key undefined so the caller's code default applies", async () => {
    const t = await loadQueueFreezeThresholds(dbReturning([{ key: FROZEN_DAYS_KEY, value: 14 }]));
    expect(t.frozenZeroOutflowDays).toBe(14);
    expect(t.slowDrainRatio).toBeUndefined();
  });

  it("FAILS OPEN when the table is unreadable — an unreadable config must not silence a detector", async () => {
    // The property that matters. Returning {} means the caller uses the code
    // constants and keeps alerting; anything else would let a config problem
    // quietly disable an operator alert, which is the failure class this whole
    // ticket is about.
    await expect(loadQueueFreezeThresholds(dbThrowing())).resolves.toEqual({});
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ["7"], [null]])(
    "ignores the unusable value %p rather than trusting it",
    async (bad) => {
      const t = await loadQueueFreezeThresholds(
        dbReturning([{ key: FROZEN_DAYS_KEY, value: bad }])
      );
      // A zero or negative window would make every queue instantly RED; a string
      // would make the comparison silently nonsense. Fall back instead.
      expect(t.frozenZeroOutflowDays).toBeUndefined();
    }
  );
});
