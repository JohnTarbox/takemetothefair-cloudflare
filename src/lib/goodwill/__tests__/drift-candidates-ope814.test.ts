/**
 * OPE-814 — the radar was pointed at the wrong pages, by a WHERE clause.
 *
 * `stale_page_radar` has touched 6 domains in its entire history; 542 of its
 * 561 all-time rows are three aggregator feeds, and it covered 1 of the 136
 * promoter-own domains where a stale-prior-year finding is both true about the
 * organizer and safe to raise with them.
 *
 * Nobody configured that. The sweep selected `APPROVED` events 30–90 days out
 * and fetched whatever `source_url` they carried; three aggregators are the
 * `source_url` on many events at once.
 *
 * Measured 2026-09-06: 242 upcoming promoter-own-domain events → **135 distinct
 * URLs** → 106 promoters. (The ticket saw 241/133/104 the day before.)
 */
import { describe, expect, it } from "vitest";
import {
  closestEvent,
  driftAgainstAll,
  groupCandidatesByUrl,
  type RawCandidateRow,
} from "../drift-candidates";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const row = (
  id: string,
  url: string | null,
  date: string | null,
  owned = false
): RawCandidateRow => ({
  eventId: id,
  sourceUrl: url,
  startDate: date ? D(date) : null,
  promoterOwned: owned,
});

describe("the unit of work is the URL, not the event", () => {
  it("36 events on one page collapse to ONE fetch — the vtfarmersmarket case", () => {
    const rows = Array.from({ length: 36 }, (_, i) =>
      row(
        `e${i}`,
        "https://vtfarmersmarket.org/",
        `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
        true
      )
    );
    const grouped = groupCandidatesByUrl(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].events).toHaveLength(36);
  });

  it("distinct URLs stay distinct", () => {
    const grouped = groupCandidatesByUrl([
      row("a", "https://one.example/", "2026-05-01"),
      row("b", "https://two.example/", "2026-05-02"),
    ]);
    // Positive landmark: a grouper that collapsed everything would satisfy the
    // assertion above.
    expect(grouped).toHaveLength(2);
  });

  it("promoter-owned pages sort first — the cap should spend on them", () => {
    const grouped = groupCandidatesByUrl([
      row("a", "https://capecodchamber.org/e/1", "2026-05-01", false),
      row("b", "https://realorganizer.org/fair", "2026-05-02", true),
    ]);
    expect(grouped[0].sourceUrl).toBe("https://realorganizer.org/fair");
  });

  it("a page is promoter-owned if ANY of its events is", () => {
    const grouped = groupCandidatesByUrl([
      row("a", "https://shared.example/", "2026-05-01", false),
      row("b", "https://shared.example/", "2026-05-08", true),
    ]);
    expect(grouped[0].promoterOwned).toBe(true);
  });

  it("rows with no URL or no date are dropped — nothing to fetch or compare", () => {
    expect(groupCandidatesByUrl([row("a", null, "2026-05-01")])).toHaveLength(0);
    expect(groupCandidatesByUrl([row("b", "https://x.example/", null)])).toHaveLength(0);
  });
});

describe("a page's date is compared against the SET we hold, not one event", () => {
  const weekly = groupCandidatesByUrl([
    row("w1", "https://market.example/", "2026-05-03", true),
    row("w2", "https://market.example/", "2026-05-10", true),
    row("w3", "https://market.example/", "2026-05-17", true),
  ])[0];

  it("a page listing ONE occurrence of a weekly market is NOT drift", () => {
    // ⚠️ The defect this prevents. Scored against an arbitrary sibling, this
    // page would show a 7-day drift forever, for every market we hold — which
    // is the shape of the four Truro Vineyard rows (one series matched to
    // different occurrences, filed as an external date conflict).
    expect(driftAgainstAll(D("2026-05-10"), weekly, 1)).toBeNull();
  });

  it("a page matching NONE of our dates IS drift, measured to the closest", () => {
    // 2026-06-14 is 28 days past our last (05-17).
    expect(driftAgainstAll(D("2026-06-14"), weekly, 1)).toBe(28);
  });

  it("a prior-year listing is drift against all of them", () => {
    const drift = driftAgainstAll(D("2025-05-03"), weekly, 1);
    expect(drift).not.toBeNull();
    expect(drift!).toBeGreaterThan(355);
  });

  it("no readable date on the page is not drift", () => {
    expect(driftAgainstAll(null, weekly, 1)).toBeNull();
  });

  it("a single-event URL behaves exactly as before", () => {
    // The change must not alter the simple case the old code handled.
    const single = groupCandidatesByUrl([row("s", "https://one.example/", "2026-05-03")])[0];
    expect(driftAgainstAll(D("2026-05-03"), single, 1)).toBeNull();
    expect(driftAgainstAll(D("2026-05-10"), single, 1)).toBe(7);
  });
});

describe("the finding is filed against the occurrence the page describes", () => {
  const weekly = groupCandidatesByUrl([
    row("w1", "https://market.example/", "2026-05-03"),
    row("w2", "https://market.example/", "2026-05-10"),
    row("w3", "https://market.example/", "2026-05-17"),
  ])[0];

  it("picks the closest event, not the first", () => {
    // Filing against the first would attribute a finding to an occurrence the
    // page is not talking about.
    expect(closestEvent(D("2026-05-16"), weekly).id).toBe("w3");
    expect(closestEvent(D("2026-05-04"), weekly).id).toBe("w1");
  });

  it("falls back to the first when the page has no date", () => {
    expect(closestEvent(null, weekly).id).toBe("w1");
  });
});
