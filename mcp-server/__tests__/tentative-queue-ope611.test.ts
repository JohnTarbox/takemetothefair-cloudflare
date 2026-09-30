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
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
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
function seedCitation(
  eventSlug: string,
  sourceType: string,
  state = "active",
  opts: { field?: string; url?: string } = {}
) {
  raw.exec(`
    INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at)
    VALUES ('c${++citeSeq}', '${eventSlug}', '${opts.field ?? "start_date"}', 'x',
            '${opts.url ?? "https://example.org/"}', '${sourceType}', '${state}', ${nowSecs}, ${nowSecs})
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

describe("OPE-611 rework — readiness reads the DATE's provenance, from someone other than us", () => {
  it("an official citation on a field that is not start_date does not make a row ready", async () => {
    // OPE-612 pass 4: six promotions whose only official citation sat on
    // indoor_outdoor / vendor_fee_max / application_instructions.
    seedEvent({ slug: "fee-only", daysOut: 5, datesConfirmed: 1 });
    seedCitation("fee-only", "official_website", "active", { field: "vendor_fee_max" });
    const [row] = await readTentativePromotionQueue(db, NOW);
    expect(row.tier).toBe("unverified");
    expect(row.officialCitationsOtherFields).toBe(1);
  });

  it("a start_date citation hosted on meetmeatthefair.com is not corroboration", async () => {
    // OPE-612 pass 5: the top search result for the club's own schedule was our
    // blog post, generated from events.start_date.
    seedEvent({ slug: "self-cited", daysOut: 5, datesConfirmed: 1 });
    seedCitation("self-cited", "official_website", "active", {
      url: "https://meetmeatthefair.com/blog/gun-shows-in-maine-2026",
    });
    const [row] = await readTentativePromotionQueue(db, NOW);
    expect(row.tier).toBe("unverified");
  });

  it("control: the same shape cited on start_date by the organizer IS ready", async () => {
    seedEvent({ slug: "organizer-cited", daysOut: 5, datesConfirmed: 1 });
    seedCitation("organizer-cited", "official_website");
    const [row] = await readTentativePromotionQueue(db, NOW);
    expect(row.tier).toBe("ready");
  });

  it("covers status TENTATIVE too — the public reader serves it", async () => {
    seedEvent({ slug: "status-tentative", daysOut: 5, status: "TENTATIVE" });
    seedEvent({ slug: "status-pending", daysOut: 5, status: "PENDING" });
    const rows = await readTentativePromotionQueue(db, NOW);
    expect(rows.map((r) => r.slug)).toEqual(["status-tentative"]);
  });
});

describe("OPE-611 rework — a checked-and-held row is no longer indistinguishable from an unopened one", () => {
  const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
  function tools() {
    const server = new CapturingMcpServer();
    registerAdminTools(server as never, db, ADMIN, {} as never);
    return server;
  }
  const parse = (r: unknown) =>
    JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

  it("record_tentative_check stamps the row, sorts it last, and keeps it out of the notice", async () => {
    seedEvent({ slug: "held", daysOut: 2, datesConfirmed: 1 });
    seedCitation("held", "official_website");
    seedEvent({ slug: "unopened", daysOut: 9, datesConfirmed: 1 });
    seedCitation("unopened", "official_website");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const out = parse(
        await tools().invoke("record_tentative_check", {
          event_id: "held",
          note: "organizer page shows May 15-16 2027 (Tentative)",
        })
      );
      expect(out.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const rows = await readTentativePromotionQueue(db, NOW);
    // Sooner and equally ready, but held: it goes behind the unopened row.
    expect(rows.map((r) => r.slug)).toEqual(["unopened", "held"]);
    expect(rows[1].recentlyChecked).toBe(true);
    expect(rows[1].checkNote).toContain("(Tentative)");
    expect(selectImminentTentative(rows).map((r) => r.slug)).toEqual(["unopened"]);

    // After the recheck window it is ordinary work again.
    const later = new Date(NOW.getTime() + 15 * DAY * 1000);
    raw.exec(
      `UPDATE events SET start_date = ${nowSecs + 20 * DAY} WHERE id IN ('held','unopened')`
    );
    const again = await readTentativePromotionQueue(db, later);
    expect(again.every((r) => !r.recentlyChecked)).toBe(true);
  });

  it("refuses to record a held verdict on a row that is not TENTATIVE", async () => {
    seedEvent({ slug: "already-scheduled", daysOut: 5, lifecycle: "SCHEDULED" });
    const out = await tools().invoke("record_tentative_check", {
      event_id: "already-scheduled",
      note: "x",
    });
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(parse(out).error).toBe("not_tentative");
  });

  it("a real transition stamps the check too", async () => {
    seedEvent({ slug: "promoted", daysOut: 30, datesConfirmed: 1 });
    await tools().invoke("update_event_lifecycle", {
      event_id: "promoted",
      new_lifecycle: "SCHEDULED",
      reason: "organizer homepage banner",
    });
    const row = raw as unknown as {
      prepare: (s: string) => { get: () => { checked: number | null; note: string | null } };
    };
    const got = row
      .prepare(
        "SELECT lifecycle_last_checked_at AS checked, lifecycle_check_note AS note FROM events WHERE id='promoted'"
      )
      .get();
    expect(got.checked).not.toBeNull();
    expect(got.note).toBe("organizer homepage banner");
  });

  it("the queue reports promotions BY ACTOR and the instant it measured at", async () => {
    seedEvent({ slug: "p1", daysOut: 30 });
    await tools().invoke("update_event_lifecycle", { event_id: "p1", new_lifecycle: "SCHEDULED" });
    const out = parse(await tools().invoke("get_tentative_promotion_queue", {}));
    expect(out.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.promotions_by_actor_last_30d).toEqual([{ actor_user_id: "u-admin", promotions: 1 }]);
  });
});
