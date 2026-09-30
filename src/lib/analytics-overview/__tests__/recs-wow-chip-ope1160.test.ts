/**
 * OPE-1160 — the Recommendations week-over-week chip must never again compare
 * two differently-defined counts.
 *
 * "Now" is the ACTIVE count (getActiveItems: seen in the last 7d, not acted on,
 * not snoozed, rule enabled). Last week's active count cannot be rebuilt —
 * last_seen_at and snoozes are overwritten, not kept as history — so the chip
 * renders the OPE-808 "not measured" state. The old chip divided that against
 * getOpenMatchCountsAsOf (no last-seen window, snoozed items included): on prod
 * 2026-09-26 page_1_zero_click_queries read "↓ −436" (108 vs 544).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");

describe("OPE-1160 — no mismatched week-over-week delta", () => {
  it("the Recommendations tab does not load the mismatched 'open as of' count", () => {
    const tab = PAGE.slice(PAGE.indexOf("async function RecommendationsTab()"));
    expect(tab).not.toContain("getOpenMatchCountsAsOf");
    expect(PAGE).not.toContain("weekAgoCounts");
  });

  it("the chip renders the not-measured state with its reason", () => {
    expect(PAGE).toContain("title={RECS_WOW_UNAVAILABLE_REASON}");
    expect(PAGE).toMatch(/const RECS_WOW_UNAVAILABLE_REASON =\s*"Week-over-week not measured:/);
  });
});
