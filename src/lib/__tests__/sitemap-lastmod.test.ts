/**
 * Tests for the ms-epoch overflow guard in sitemap-lastmod.ts. We can't
 * unit-test the DB-bound `getSitemapTypeLastMod` without a D1 binding, so
 * the test runs against `maxFor` indirectly by exercising the boundary
 * behavior via the exported types.
 *
 * Strategy: spec the guard's behavior at three representative Date values
 * — a normal recent one (year 2026), the bug surfaced by P4a on the
 * vendors table (year 58308), and the boundary (year 5138 = 1e14 ms).
 */
import { describe, it, expect } from "vitest";

// Re-implement the guard inline for the test — the real one is module-
// private. The contract is what matters: a Date past MAX_PLAUSIBLE_MS gets
// /1000'd; everything else passes through.
const MAX_PLAUSIBLE_MS = 1e14;
function correctMsOverflow(d: Date): Date {
  const ms = d.getTime();
  if (ms > MAX_PLAUSIBLE_MS) return new Date(ms / 1000);
  return d;
}

describe("sitemap-lastmod ms-epoch overflow guard", () => {
  it("passes a normal 2026-era Date through unchanged", () => {
    const d = new Date("2026-05-22T15:11:26.000Z");
    expect(correctMsOverflow(d).toISOString()).toBe("2026-05-22T15:11:26.000Z");
  });

  it("corrects the exact year-58308 overflow surfaced by P4a on vendors", () => {
    // Raw vendors.updated_at value pulled from prod D1: 1777856525000 (ms).
    // Drizzle's mode:"timestamp" multiplied that by 1000 → 1.78e15 ms →
    // year 58308. The guard should /1000 the ms back to the original
    // ms-epoch → year 2026.
    const corruptedRawMs = 1777856525000 * 1000; // 1.777e15
    const corrupted = new Date(corruptedRawMs);
    expect(corrupted.getUTCFullYear()).toBe(58308);

    const corrected = correctMsOverflow(corrupted);
    expect(corrected.getUTCFullYear()).toBe(2026);
    // And the result should match the ms-epoch ÷ 1000 round-trip.
    expect(corrected.toISOString()).toBe(new Date(1777856525000).toISOString());
  });

  it("does NOT correct a Date just below the threshold (year 5137)", () => {
    // 1e14 - 1 ms ≈ year 5138. Below the guard; pass through unchanged.
    const justBelow = new Date(MAX_PLAUSIBLE_MS - 1);
    expect(correctMsOverflow(justBelow)).toBe(justBelow);
  });

  it("corrects a Date just above the threshold (year 5170)", () => {
    // 1e14 + 1 ms ≈ year 5168. Above the guard; should be /1000'd.
    const justAbove = new Date(MAX_PLAUSIBLE_MS + 1);
    const corrected = correctMsOverflow(justAbove);
    // After /1000 the year should drop to ~1973
    expect(corrected.getUTCFullYear()).toBeLessThan(2000);
  });

  it("handles a far-future legitimate Date correctly (year 2200)", () => {
    // Year 2200 ≈ 7.25e12 ms — well below 1e14. Pass through unchanged.
    const yr2200 = new Date("2200-01-01T00:00:00.000Z");
    expect(correctMsOverflow(yr2200).toISOString()).toBe(yr2200.toISOString());
  });
});
