/**
 * OPE-483 — a retired scraper must announce itself, not vanish.
 *
 * The failure this pins: mainefairs.net sat at `last_synced_at == created_at`
 * for seven months across 20 events, with `sync_enabled = 1` on 19 of them, and
 * nothing ever said so. Three separate silences had to line up for that:
 *
 *   1. the site was rebuilt and both the scraper's calendar URL and its
 *      per-event URLs started 404ing;
 *   2. no cron calls `PATCH /api/admin/import`, the only reader of the flag;
 *   3. and if one had, an unresolvable source was counted as `unchanged` —
 *      the same bucket as "we checked and it was already current".
 *
 * (1) is upstream's business and (2) is a scheduling decision. (3) is the one
 * that made the other two invisible, so it is the one with a test.
 */
import { describe, it, expect } from "vitest";
import { getScraper, getDetailsScraper, getScraperRetirement } from "../registry";

describe("retirement is visible without removing the entry", () => {
  it("mainefairs.net is marked retired, with a date and a reason", () => {
    const retired = getScraperRetirement("mainefairs.net");
    expect(retired).toBeDefined();
    // A retirement is a claim about a live site. Undated, it cannot be re-checked.
    expect(retired!.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(retired!.reason.length).toBeGreaterThan(20);
  });

  it("the entry STAYS in the registry — deleting it would restore the silence", () => {
    // `getScraper` returning undefined is how the importer decides "unknown
    // source, skip", which is exactly the indistinguishable-from-success path.
    expect(getScraper("mainefairs.net")).toBeDefined();
    expect(getDetailsScraper("mainefairs.net")).toBeTypeOf("function");
  });

  it("a live source reports no retirement", () => {
    expect(getScraperRetirement("mafa.org")).toBeUndefined();
    expect(getScraperRetirement("vtnhfairs.org")).toBeUndefined();
  });

  it("an unrecognised label is not a retirement — the two are different findings", () => {
    // A retired source is a finding about the world; an unknown one is usually a
    // typo in our own data. The importer counts them separately for that reason.
    expect(getScraperRetirement("not-a-real-source.example")).toBeUndefined();
    expect(getDetailsScraper("not-a-real-source.example")).toBeUndefined();
  });

  it("null/undefined source names are handled without throwing", () => {
    expect(getScraperRetirement(null)).toBeUndefined();
    expect(getScraperRetirement(undefined)).toBeUndefined();
  });
});
