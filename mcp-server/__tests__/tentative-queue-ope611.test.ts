/**
 * OPE-611 — TENTATIVE was a state with no way out.
 *
 * The Aug 28–30 weekend digest had ZERO New Hampshire events on the biggest
 * fair weekend of the year. The Concord gem show was in the database and
 * correct in every field — organizer's own site, active official_website
 * citation at 0.95, dates_confirmed=1, gate_flags NULL — and was suppressed by
 * `lifecycle_status='TENTATIVE'` alone. It was found by hand ONE DAY before it
 * opened.
 *
 * The rows seeded below are the REAL live cohort as measured on 2026-08-28,
 * not invented shapes. That matters most for Kefi Greek Festival: it carries
 * `["name_em_dash_subvenue"]` next to dates_confirmed=1 and an official
 * citation, so it is the best-LOOKING candidate an auto-promotion rule would
 * see and exactly the one it must refuse. A hand-made fixture would not have
 * produced that case.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  readTentativePromotionQueue,
  selectImminentTentative,
  readinessTier,
  IMMINENT_DAYS,
} from "../src/events/tentative-queue.js";
import { readOperatorQueues, decideOperatorQueueNotice } from "../src/operator-queue-notice.js";

const NOW = new Date("2026-08-28T12:00:00Z");
const DAY = 86400;
const nowSecs = Math.floor(NOW.getTime() / 1000);

let db: TestDb;
let raw: { exec: (s: string) => unknown };

/** `events.promoter_id` is NOT NULL — every event needs one. */
const PROMOTER_ID = "p-test";

function seedEvent(o: {
  slug: string;
  name?: string;
  daysOut: number;
  status?: string;
  lifecycle?: string;
  datesConfirmed?: number;
  gateFlags?: string | null;
  views?: number;
}) {
  const start = nowSecs + o.daysOut * DAY;
  raw.exec(`
    INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, dates_confirmed,
                        status, view_count, lifecycle_status, gate_flags)
    VALUES ('${o.slug}', '${(o.name ?? o.slug).replace(/'/g, "''")}', '${o.slug}', '${PROMOTER_ID}',
            ${start}, ${start + DAY}, ${o.datesConfirmed ?? 0},
            '${o.status ?? "APPROVED"}', ${o.views ?? 0},
            '${o.lifecycle ?? "TENTATIVE"}',
            ${o.gateFlags == null ? "NULL" : `'${o.gateFlags}'`})
  `);
}

let citeSeq = 0;
function seedCitation(eventSlug: string, sourceType: string, state = "active") {
  raw.exec(`
    INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at)
    VALUES ('c${++citeSeq}', '${eventSlug}', 'start_date', 'x',
            'https://example.org/', '${sourceType}', '${state}', ${nowSecs}, ${nowSecs})
  `);
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as { exec: (s: string) => unknown };
  raw.exec(
    `INSERT INTO promoters (id, company_name, slug) VALUES ('${PROMOTER_ID}', 'Test Promoter', 'test-promoter')`
  );
  citeSeq = 0;
});

describe("readinessTier — the rule OPE-611 §3 asks to be written down", () => {
  it("is 'unverified' with no official citation, however confirmed the dates", () => {
    expect(readinessTier({ datesConfirmed: true, officialCitations: 0, gateFlags: null })).toBe(
      "unverified"
    );
  });

  it("is 'ready' only on all three conditions together", () => {
    expect(readinessTier({ datesConfirmed: true, officialCitations: 1, gateFlags: null })).toBe(
      "ready"
    );
  });

  it("DEMOTES a gate-flagged row to 'probable' — the Kefi case", () => {
    // Live row: dates_confirmed=1, one active official_website citation, and
    // gate_flags ["name_em_dash_subvenue"]. Without the gate clause this is the
    // highest-scoring row in the whole cohort, which is what makes it the
    // dangerous one rather than merely an excluded one.
    expect(
      readinessTier({
        datesConfirmed: true,
        officialCitations: 1,
        gateFlags: '["name_em_dash_subvenue"]',
      })
    ).toBe("probable");
  });

  it("is 'probable' when the organizer source exists but dates are unconfirmed", () => {
    expect(readinessTier({ datesConfirmed: false, officialCitations: 2, gateFlags: null })).toBe(
      "probable"
    );
  });
});

describe("readTentativePromotionQueue", () => {
  it("counts ONLY active citations — a superseded official source does not confer readiness", () => {
    seedEvent({ slug: "superseded-only", daysOut: 5, datesConfirmed: 1 });
    seedCitation("superseded-only", "official_website", "superseded");
    return readTentativePromotionQueue(db, NOW).then((rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0].officialCitations).toBe(0);
      expect(rows[0].tier).toBe("unverified");
    });
  });

  it("counts ONLY official_website for the official tally — a news article is not organizer-grade", async () => {
    seedEvent({ slug: "news-only", daysOut: 5, datesConfirmed: 1 });
    seedCitation("news-only", "news_article");
    const [row] = await readTentativePromotionQueue(db, NOW);
    expect(row.officialCitations).toBe(0);
    expect(row.anyCitations).toBe(1);
    expect(row.tier).toBe("unverified");
  });

  it("excludes SCHEDULED events — the queue is what has NOT been promoted", async () => {
    seedEvent({ slug: "already-scheduled", daysOut: 5, lifecycle: "SCHEDULED" });
    expect(await readTentativePromotionQueue(db, NOW)).toHaveLength(0);
  });

  it("excludes non-APPROVED rows", async () => {
    seedEvent({ slug: "pending-row", daysOut: 5, status: "PENDING" });
    expect(await readTentativePromotionQueue(db, NOW)).toHaveLength(0);
  });

  it("excludes events that have already started", async () => {
    seedEvent({ slug: "past-row", daysOut: -3 });
    expect(await readTentativePromotionQueue(db, NOW)).toHaveLength(0);
  });

  it("ranks ready before probable, then soonest, then most-viewed", async () => {
    seedEvent({ slug: "probable-soon", daysOut: 1, datesConfirmed: 0 });
    seedCitation("probable-soon", "official_website");
    seedEvent({ slug: "ready-later", daysOut: 9, datesConfirmed: 1 });
    seedCitation("ready-later", "official_website");
    seedEvent({ slug: "ready-sooner", daysOut: 4, datesConfirmed: 1 });
    seedCitation("ready-sooner", "official_website");

    const rows = await readTentativePromotionQueue(db, NOW);
    // Tier dominates recency: `probable-soon` starts tomorrow and still sorts
    // last, because the operator's scarce attention should land on the rows a
    // decision can actually be made about.
    expect(rows.map((r) => r.slug)).toEqual(["ready-sooner", "ready-later", "probable-soon"]);
  });

  it("honours withinSeconds so the alert path does not read the whole backlog", async () => {
    seedEvent({ slug: "near", daysOut: 3 });
    seedEvent({ slug: "far", daysOut: 200 });
    const rows = await readTentativePromotionQueue(db, NOW, { withinSeconds: 14 * DAY });
    expect(rows.map((r) => r.slug)).toEqual(["near"]);
  });
});

describe("selectImminentTentative — what is worth an operator email", () => {
  it("drops 'unverified' rows: there is nothing for the operator to act on", async () => {
    seedEvent({ slug: "no-source", daysOut: 2, datesConfirmed: 1 });
    const rows = await readTentativePromotionQueue(db, NOW);
    expect(rows[0].tier).toBe("unverified");
    expect(selectImminentTentative(rows)).toHaveLength(0);
  });

  it("includes the boundary day and excludes the one past it", async () => {
    seedEvent({ slug: "on-boundary", daysOut: IMMINENT_DAYS });
    seedCitation("on-boundary", "official_website");
    seedEvent({ slug: "past-boundary", daysOut: IMMINENT_DAYS + 1 });
    seedCitation("past-boundary", "official_website");
    const rows = await readTentativePromotionQueue(db, NOW);
    expect(selectImminentTentative(rows).map((r) => r.slug)).toEqual(["on-boundary"]);
  });
});

describe("the notice fires on the tentative queue ALONE", () => {
  it("alerts with zero claims and zero reply drafts — the third queue stands on its own", async () => {
    // The regression this guards: adding a queue to a notice whose decision
    // summed only the first two would surface nothing, and the new queue would
    // be silent in exactly the way OPE-611 is about.
    seedEvent({
      slug: "gem-show-shape",
      name: "Capital Mineral Club Gem Show",
      daysOut: 1,
      datesConfirmed: 1,
      views: 1486,
    });
    seedCitation("gem-show-shape", "official_website");

    const counts = await readOperatorQueues(db, NOW);
    expect(counts.agedClaims).toBe(0);
    expect(counts.agedReplies).toBe(0);
    expect(counts.imminentTentative).toBe(1);
    expect(decideOperatorQueueNotice(counts, false)).toBe(true);
    expect(counts.lines.some((l) => l.includes("Capital Mineral Club Gem Show"))).toBe(true);
  });

  it("stays SILENT when all three queues are empty", async () => {
    const counts = await readOperatorQueues(db, NOW);
    expect(counts.imminentTentative).toBe(0);
    expect(decideOperatorQueueNotice(counts, false)).toBe(false);
  });

  it("stays silent when the only tentative events are far out", async () => {
    seedEvent({ slug: "next-season", daysOut: 120, datesConfirmed: 1 });
    seedCitation("next-season", "official_website");
    const counts = await readOperatorQueues(db, NOW);
    expect(decideOperatorQueueNotice(counts, false)).toBe(false);
  });
});
