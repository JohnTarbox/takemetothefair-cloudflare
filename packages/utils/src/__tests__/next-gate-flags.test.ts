/**
 * OPE-435 — `gate_flags` must CLEAR when the condition it names is repaired.
 *
 * The column was add-only: the write lived inside `if (route ===
 * "PENDING_REVIEW")`, so a repaired row kept a flag asserting something that
 * no longer held. Two live specimens:
 *
 *   ba1eaea4  start_date exactly 12:00:00Z — the canonical clean anchor, where
 *             `dateLooksTimezoneConfused` returns false immediately — still
 *             carrying ["start_date_timezone_confused"].
 *   KCCV      `end_date_in_past` on an event ending 2026-11-22, surviving two
 *             `update_event` calls AND an approve.
 *
 * The cost is that the channel stops being read. The analyst who found the
 * second one wrote: "I did ignore it. It was inert, the approve went through,
 * and I only checked because the value looked impossible."
 */
import { describe, it, expect } from "vitest";
import { nextGateFlags } from "../next-gate-flags";

describe("nextGateFlags", () => {
  it("CLEARS a stale flag when the gate now returns clean — the defect", () => {
    const out = nextGateFlags({
      currentFlags: '["start_date_timezone_confused"]',
      route: "APPROVED",
      reasons: [],
    });
    expect(out.write).toBe(true);
    expect(out.value).toBeNull();
    expect(out.warning).toBeNull();
  });

  it("clears SIBLING reasons too, because one evaluator produces them all", () => {
    // `source_tier_3_aggregator` comes from `evaluateGates` itself
    // (event-date-gates.ts:504), not from another subsystem. A clean verdict
    // is therefore an authoritative "nothing applies" — preserving siblings
    // would preserve reasons the same evaluator just declined to produce.
    const out = nextGateFlags({
      currentFlags: '["start_date_timezone_confused","source_tier_3_aggregator"]',
      route: "APPROVED",
      reasons: [],
    });
    expect(out.value).toBeNull();
  });

  it("does NOT write when the row was never flagged and is still clean", () => {
    // Writing null here would bump `updated_at` on a row with no user-visible
    // change — and since OPE-308 that drives sitemap `lastmod` and the
    // conditional-GET validator, so it would tell search engines a page
    // changed when it did not.
    const out = nextGateFlags({ currentFlags: null, route: "APPROVED", reasons: [] });
    expect(out.write).toBe(false);
  });

  it("treats an empty string and whitespace as unflagged", () => {
    expect(nextGateFlags({ currentFlags: "", route: "APPROVED", reasons: [] }).write).toBe(false);
    expect(nextGateFlags({ currentFlags: "   ", route: "APPROVED", reasons: [] }).write).toBe(
      false
    );
  });

  it("writes the firing reasons when the gate still fires", () => {
    const out = nextGateFlags({
      currentFlags: null,
      route: "PENDING_REVIEW",
      reasons: ["end_date_in_past"],
    });
    expect(out.write).toBe(true);
    expect(out.value).toBe('["end_date_in_past"]');
    expect(out.warning).toEqual(["end_date_in_past"]);
  });

  it("REPLACES rather than merges when the set of reasons shrinks", () => {
    // A row flagged for two reasons that now trips only one must end up with
    // one. Merging would make the column monotonic in a second way and
    // reintroduce the same defect through the back door.
    const out = nextGateFlags({
      currentFlags: '["start_date_timezone_confused","end_date_in_past"]',
      route: "PENDING_REVIEW",
      reasons: ["end_date_in_past"],
    });
    expect(out.value).toBe('["end_date_in_past"]');
  });

  it("surfaces a warning only when something actually fires", () => {
    expect(
      nextGateFlags({ currentFlags: '["x"]', route: "APPROVED", reasons: [] }).warning
    ).toBeNull();
  });
});
