/**
 * OPE-1586 — TENTATIVE → SCHEDULED only when a fresh read of the cited
 * organizer page agrees (John, 2026-11-16, option 2).
 *
 * The page specimens are the real shapes from the ticket: Biddeford's
 * "(Tentative)", Brookfield's page listing a different date, and the four
 * the analyst's 19–22 Nov hand-check said would trip a naive check (year only
 * in a heading, "TBA" away from the date, "canceled" in refund policy, a
 * weekday list before a range).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { pageAgreesWithStartDate, newYorkDate } from "../src/events/page-date-agreement.js";
import { runTentativeAutopromote, type PageFetcher } from "../src/events/tentative-autopromote.js";
import { readOperatorQueues } from "../src/operator-queue-notice.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const DAY = 86400;
const nowSecs = Math.floor(NOW.getTime() / 1000);
// Stored dates are noon UTC (the live convention), so the NY date is the same day.
const NOV20 = new Date("2026-11-20T12:00:00Z"); // a Friday
const NOV21 = new Date("2026-11-21T12:00:00Z"); // a Saturday

const html = (body: string, extraHead = "") =>
  `<html><head><title>Event</title>${extraHead}</head><body>${body}</body></html>`;

describe("pageAgreesWithStartDate — the page check", () => {
  it("reads the date in America/New_York", () => {
    expect(newYorkDate(NOV20)).toMatchObject({ year: 2026, month: 11, day: 20, weekday: 5 });
    // 03:00Z on the 21st is still the 20th in New York.
    expect(newYorkDate(new Date("2026-11-21T03:00:00Z")).day).toBe(20);
  });

  it("agrees on a plain dated line", () => {
    const v = pageAgreesWithStartDate(
      html(
        "<h1>Holiday Market</h1><p>Friday, November 20, 2026 from 10am to 4pm at the Grange.</p>"
      ),
      NOV20
    );
    expect(v.agrees).toBe(true);
  });

  it("HOLDS the Biddeford specimen: matching dates marked (Tentative)", () => {
    const may15 = new Date("2027-05-15T12:00:00Z");
    const v = pageAgreesWithStartDate(
      html(
        "<h2>Biddeford Gun Show</h2><p>May 15th &amp; 16th, 2027 (Tentative)</p><p>Admission $8.</p>"
      ),
      may15
    );
    expect(v).toMatchObject({ agrees: false, reason: "hedged" });
  });

  it("HOLDS a page that shows a different date (the Brookfield shape)", () => {
    const oct17 = new Date("2026-10-17T12:00:00Z");
    const v = pageAgreesWithStartDate(
      html(
        "<h1>Harvest Craft Fair 2026</h1><p>Join us September 12-13, 2026 for crafts and cider.</p>"
      ),
      oct17
    );
    expect(v).toMatchObject({ agrees: false, reason: "date_absent" });
  });

  it("HOLDS last year's edition (the date with a different year attached)", () => {
    const v = pageAgreesWithStartDate(
      html(
        "<h1>Craft Fair</h1><p>Our last show was November 20, 2025. Thanks to all our vendors and visitors!</p>"
      ),
      NOV20
    );
    expect(v).toMatchObject({ agrees: false, reason: "year_mismatch" });
  });

  it("HOLDS when the written weekday is wrong for our year (stale page with no year)", () => {
    // America's Hometown Thanksgiving Parade: the organizer dates only
    // Saturday Nov 21; a stale "Saturday, November 20" would be from a year
    // the 20th was a Saturday — not 2026.
    const v = pageAgreesWithStartDate(
      html(
        "<h1>Parade 2026</h1><p>Saturday, November 20 — parade steps off at 9:30 along Court Street.</p>"
      ),
      NOV20
    );
    expect(v.agrees).toBe(false);
  });

  it("AGREES when the year appears only in a heading (ZooLights / Thompson's Point specimen)", () => {
    const v = pageAgreesWithStartDate(
      html(
        "<h1>ZooLights 2026</h1><p>November 20 - January 3. Select nights, 5–9pm. Tickets on sale now.</p>"
      ),
      NOV20
    );
    expect(v.agrees).toBe(true);
  });

  it("HOLDS a year-less date when our year is nowhere on the page", () => {
    const v = pageAgreesWithStartDate(
      html(
        "<h1>Makers Market</h1><p>NOVEMBER 20* — over forty local makers, food trucks and music.</p>"
      ),
      NOV20
    );
    expect(v).toMatchObject({ agrees: false, reason: "date_absent" });
  });

  it("ignores a 'TBA' far from the date (PTTF specimen)", () => {
    const filler = " Lorem ipsum dolor sit amet, consectetur adipiscing elit.".repeat(6);
    const v = pageAgreesWithStartDate(
      html(
        `<h1>PTTF Holiday Craft Fair</h1><p>Saturday, November 21, 2026, 9-3.</p><p>${filler}</p><h3>Crafters</h3><p>more info TBA</p>`
      ),
      NOV21
    );
    expect(v.agrees).toBe(true);
  });

  it("ignores 'canceled' in refund policy away from the date (Sparkling Lights specimen)", () => {
    const filler = " Bring the whole family and enjoy cocoa and carols by the fire.".repeat(4);
    const v = pageAgreesWithStartDate(
      html(
        `<h1>Sparkling Lights</h1><p>Opens November 20, 2026.</p><p>${filler}</p><p>Refunds: tickets for nights canceled for weather are refunded.</p>`
      ),
      NOV20
    );
    expect(v.agrees).toBe(true);
  });

  it("accepts a weekday LIST before a range ('Friday & Saturday, Nov 20-21')", () => {
    const v = pageAgreesWithStartDate(
      html(
        "<h1>Holiday Fair 2026</h1><p>Friday &amp; Saturday, Nov 20-21 — free admission, 40 vendors.</p>"
      ),
      NOV20
    );
    expect(v.agrees).toBe(true);
  });

  it("does not read a date out of a link URL", () => {
    const v = pageAgreesWithStartDate(
      html(
        '<h1>Holiday Market</h1><p>See <a href="https://example.org/event/2026-11-20/">our event page</a> for details and directions to the venue.</p>'
      ),
      NOV20
    );
    expect(v).toMatchObject({ agrees: false, reason: "date_absent" });
  });

  it("accepts a JSON-LD startDate, unless the block says it is postponed", () => {
    const ld = (status = "") =>
      `<script type="application/ld+json">{"@type":"Event","startDate":"2026-11-20T10:00:00-05:00"${status}}</script>`;
    expect(pageAgreesWithStartDate(html("<div id=app></div>", ld()), NOV20)).toMatchObject({
      agrees: true,
      via: "json-ld",
    });
    expect(
      pageAgreesWithStartDate(
        html("<div id=app></div>", ld(',"eventStatus":"https://schema.org/EventPostponed"')),
        NOV20
      ).agrees
    ).toBe(false);
  });

  it("HOLDS an empty (script-rendered) page", () => {
    expect(pageAgreesWithStartDate(html('<div id="root"></div>'), NOV20)).toMatchObject({
      agrees: false,
      reason: "no_text",
    });
  });
});

// ─── The sweep ──────────────────────────────────────────────────────────────

let db: TestDb;
let raw: {
  exec: (s: string) => unknown;
  prepare: (s: string) => {
    all: (...a: unknown[]) => unknown[];
    get: (...a: unknown[]) => unknown;
  };
};
const PROMOTER_ID = "p-test";

function seedEvent(o: {
  id: string;
  start: Date;
  lifecycle?: string;
  datesConfirmed?: number;
  checkedSecsAgo?: number;
}) {
  const start = Math.floor(o.start.getTime() / 1000);
  raw.exec(`
    INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, dates_confirmed,
                        status, view_count, lifecycle_status, lifecycle_last_checked_at)
    VALUES ('${o.id}', '${o.id}', '${o.id}', '${PROMOTER_ID}', ${start}, ${start + DAY},
            ${o.datesConfirmed ?? 1}, 'APPROVED', 0, '${o.lifecycle ?? "TENTATIVE"}',
            ${o.checkedSecsAgo == null ? "NULL" : nowSecs - o.checkedSecsAgo})
  `);
  raw.exec(`
    INSERT INTO event_data_citations (id, event_id, field_name, value, source_url, source_type, state, created_at, updated_at)
    VALUES ('c-${o.id}', '${o.id}', 'start_date', 'x', 'https://organizer.example/${o.id}',
            'official_website', 'active', ${nowSecs}, ${nowSecs})
  `);
}

function lifecycle(id: string): string {
  return (
    raw.prepare(`SELECT lifecycle_status AS l FROM events WHERE id = ?`).get(id) as { l: string }
  ).l;
}

/** Pages keyed by event id; `null` = the fetch fails. */
function fetcherFor(pages: Record<string, string | null>): PageFetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const id = url.split("/").pop()!;
    const page = pages[id];
    if (page == null)
      return { ok: false, html: null, fetchMethod: "failed" as const, failReason: "http-503" };
    return { ok: true, html: page, fetchMethod: "standard" as const };
  }) as PageFetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

const AGREE_NOV20 = html(
  "<h1>Fair</h1><p>Friday, November 20, 2026 — 10am to 4pm, rain or shine.</p>"
);

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as typeof raw;
  raw.exec(
    `INSERT INTO promoters (id, company_name, slug) VALUES ('${PROMOTER_ID}', 'Test Promoter', 'test-promoter')`
  );
});

describe("runTentativeAutopromote", () => {
  it("promotes an agreeing page, holds the rest, and writes the audit trail", async () => {
    seedEvent({ id: "agrees", start: NOV20 });
    seedEvent({ id: "biddeford", start: NOV20 });
    seedEvent({ id: "other-date", start: NOV20 });
    seedEvent({ id: "fetch-fails", start: NOV20 });
    seedEvent({ id: "probable", start: NOV20, datesConfirmed: 0 });
    seedEvent({ id: "human-held", start: NOV20, checkedSecsAgo: 2 * DAY });
    seedEvent({ id: "too-far", start: new Date(NOW.getTime() + 30 * DAY * 1000) });

    const fetchPage = fetcherFor({
      agrees: AGREE_NOV20,
      biddeford: html(
        "<h1>Gun Show</h1><p>November 20th &amp; 21st, 2026 (Tentative)</p><p>Tables $50.</p>"
      ),
      "other-date": html(
        "<h1>Fair 2026</h1><p>Saturday, December 5, 2026 at the town hall, all day long.</p>"
      ),
      "fetch-fails": null,
      probable: AGREE_NOV20,
      "human-held": AGREE_NOV20,
      "too-far": AGREE_NOV20,
    });

    const r = await runTentativeAutopromote(db, { now: NOW, fetchPage });

    expect(r.promoted.map((p) => p.slug)).toEqual(["agrees"]);
    expect(lifecycle("agrees")).toBe("SCHEDULED");
    const held = Object.fromEntries(r.held.map((h) => [h.slug, h.reason]));
    expect(held).toEqual({
      biddeford: "hedged",
      "other-date": "date_absent",
      "fetch-fails": "fetch_failed",
    });
    for (const id of [
      "biddeford",
      "other-date",
      "fetch-fails",
      "probable",
      "human-held",
      "too-far",
    ]) {
      expect(lifecycle(id)).toBe("TENTATIVE");
    }
    // Positive landmark: exactly the four ready, unchecked, in-window rows were fetched.
    expect(r.examined).toBe(4);
    expect(fetchPage.calls.map((u) => u.split("/").pop()).sort()).toEqual(
      ["agrees", "biddeford", "fetch-fails", "other-date"].sort()
    );

    // The lifecycle-history row names the rule and the URL it matched.
    const audit = raw
      .prepare(
        `SELECT payload_json AS p FROM admin_actions WHERE action = 'event.lifecycle_change' AND target_id = 'agrees'`
      )
      .all() as { p: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].p)).toMatchObject({
      previous_lifecycle: "TENTATIVE",
      new_lifecycle: "SCHEDULED",
      via: "tentative-autopromote",
      rule: "OPE-1586",
      matched_url: "https://organizer.example/agrees",
    });

    // A HELD row is not stamped as checked — it must stay in the operator digest.
    const checked = raw
      .prepare(`SELECT lifecycle_last_checked_at AS c FROM events WHERE id = 'fetch-fails'`)
      .get() as { c: number | null };
    expect(checked.c).toBeNull();

    // One run row and the heartbeat stamp.
    const run = raw
      .prepare(
        `SELECT payload_json AS p FROM admin_actions WHERE action = 'event.tentative_autopromote_run'`
      )
      .all() as { p: string }[];
    expect(run).toHaveLength(1);
    expect(JSON.parse(run[0].p).summary).toBe(
      "auto-promoted 1; 3 left for review (date_absent ×1, fetch_failed ×1, hedged ×1)"
    );
    const hb = raw
      .prepare(
        `SELECT note FROM agent_heartbeats WHERE agent_code = 'watchdog:tentative-autopromote'`
      )
      .get() as { note: string } | undefined;
    expect(hb?.note).toContain("promoted=1");
  });

  it("stamps the heartbeat and writes a run row even when nothing is a candidate", async () => {
    const r = await runTentativeAutopromote(db, { now: NOW, fetchPage: fetcherFor({}) });
    expect(r.summary).toBe("auto-promoted 0; 0 left for review");
    const hb = raw
      .prepare(
        `SELECT 1 AS x FROM agent_heartbeats WHERE agent_code = 'watchdog:tentative-autopromote'`
      )
      .get();
    expect(hb).toBeTruthy();
  });

  it("reverses its own promotion when the page later disagrees, flags it, and does not re-promote", async () => {
    seedEvent({ id: "flip", start: NOV20 });
    await runTentativeAutopromote(db, { now: NOW, fetchPage: fetcherFor({ flip: AGREE_NOV20 }) });
    expect(lifecycle("flip")).toBe("SCHEDULED");

    const later = new Date(NOW.getTime() + DAY * 1000);
    const changed = html(
      "<h1>Fair 2026</h1><p>POSTPONED — new date to be announced. Check back soon for updates.</p>"
    );
    const r2 = await runTentativeAutopromote(db, {
      now: later,
      fetchPage: fetcherFor({ flip: changed }),
    });
    expect(r2.demoted.map((d) => d.slug)).toEqual(["flip"]);
    expect(lifecycle("flip")).toBe("TENTATIVE");
    const flag = raw
      .prepare(
        `SELECT reason FROM event_review_flags WHERE event_id = 'flip' AND cleared_at IS NULL`
      )
      .all() as { reason: string }[];
    expect(flag.map((f) => f.reason)).toContain("auto_promotion_reversed");

    // Even if the page agrees again, a reversed row waits for a person.
    const r3 = await runTentativeAutopromote(db, {
      now: new Date(later.getTime() + DAY * 1000),
      fetchPage: fetcherFor({ flip: AGREE_NOV20 }),
    });
    expect(r3.promoted).toEqual([]);
    expect(lifecycle("flip")).toBe("TENTATIVE");
  });

  it("does NOT demote on a failed re-read, nor a row a person has since transitioned", async () => {
    seedEvent({ id: "flaky", start: NOV20 });
    seedEvent({ id: "human-after", start: NOV20 });
    await runTentativeAutopromote(db, {
      now: NOW,
      fetchPage: fetcherFor({ flaky: AGREE_NOV20, "human-after": AGREE_NOV20 }),
    });
    // A person re-transitions human-after afterwards (any later lifecycle_change not via the rule).
    raw.exec(`
      INSERT INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at)
      VALUES ('h1', 'event.lifecycle_change', 'u-john', 'event', 'human-after',
              '{"previous_lifecycle":"SCHEDULED","new_lifecycle":"SCHEDULED","slug":"human-after"}', ${nowSecs + 3600})
    `);
    const later = new Date(NOW.getTime() + DAY * 1000);
    const r = await runTentativeAutopromote(db, {
      now: later,
      fetchPage: fetcherFor({
        flaky: null,
        "human-after": html(
          "<h1>Fair 2026</h1><p>See you next year! Dates for 2027 will be posted in the spring.</p>"
        ),
      }),
    });
    expect(r.rechecked).toBe(1);
    expect(r.demoted).toEqual([]);
    expect(lifecycle("flaky")).toBe("SCHEDULED");
    expect(lifecycle("human-after")).toBe("SCHEDULED");
  });

  it("puts ONE summary line in the operator digest, and the held reason on each held row", async () => {
    seedEvent({ id: "agrees", start: NOV20 });
    seedEvent({ id: "fetch-fails", start: NOV20 });
    await runTentativeAutopromote(db, {
      now: NOW,
      fetchPage: fetcherFor({ agrees: AGREE_NOV20, "fetch-fails": null }),
    });
    const counts = await readOperatorQueues(db, NOW, {});
    const summary = counts.lines.filter((l) => l.includes("TENTATIVE auto-promotion (OPE-1586)"));
    expect(summary).toEqual([
      "TENTATIVE auto-promotion (OPE-1586): auto-promoted 1; 1 left for review (fetch_failed ×1)",
    ]);
    // The digest lists only what the rule could not confirm.
    const tentativeLines = counts.lines.filter(
      (l) => l.startsWith("TENTATIVE ") && !l.includes("OPE-1586):")
    );
    expect(tentativeLines).toHaveLength(1);
    expect(tentativeLines[0]).toContain("(fetch-fails)");
    expect(tentativeLines[0]).toContain("auto-check held: fetch_failed");
    expect(counts.imminentTentative).toBe(1);
  });
});

// ── OPE-1661 — a D1 overload between the UPDATE and its audit row ───────────
//
// 2026-11-17 06:00Z: 8 agreeing rows hit "D1 DB is overloaded". 7 failed on the
// UPDATE (left TENTATIVE, fine); winter-lights-at-shelburne-museum failed on
// the audit INSERT AFTER its UPDATE landed — SCHEDULED with no audit row, so
// pass 3 could never see it. error_logs held none of the 8 (the logger's own
// insert hit the same overload).
describe("runTentativeAutopromote — D1 overload (OPE-1661)", () => {
  const OVERLOAD =
    "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.";
  const overloadError = () =>
    Object.assign(new Error('Failed query: update "events" …'), { cause: new Error(OVERLOAD) });

  type Batchable = { batch: (s: unknown[]) => Promise<unknown[]> };
  const shimBatch = () => (db as unknown as Batchable).batch.bind(db);

  /** D1's batch is a transaction; the shared shim is not. Make this one be. */
  function transactionalBatch() {
    const inner = shimBatch();
    (db as unknown as Batchable).batch = async (stmts) => {
      raw.exec("BEGIN");
      try {
        const out = await inner(stmts);
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    };
  }

  function auditRows(id: string) {
    return raw
      .prepare(
        `SELECT payload_json AS p FROM admin_actions WHERE action = 'event.lifecycle_change' AND target_id = ?`
      )
      .all(id) as { p: string }[];
  }

  it("retries a transient overload, and the promotion lands WITH its audit row", async () => {
    seedEvent({ id: "agrees", start: NOV20 });
    const inner = shimBatch();
    let failures = 1;
    (db as unknown as Batchable).batch = async (s) => {
      if (failures-- > 0) throw overloadError();
      return inner(s);
    };
    const sleeps: number[] = [];
    const r = await runTentativeAutopromote(db, {
      now: NOW,
      fetchPage: fetcherFor({ agrees: AGREE_NOV20 }),
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([2000]);
    expect(r.errors).toBe(0);
    expect(r.promoted.map((p) => p.slug)).toEqual(["agrees"]);
    expect(lifecycle("agrees")).toBe("SCHEDULED");
    expect(auditRows("agrees")).toHaveLength(1);
    // The insert-select maps every column, not just the payload.
    expect(
      raw
        .prepare(
          `SELECT action, actor_user_id AS actor, target_type AS tt, created_at AS ca
             FROM admin_actions WHERE target_id = 'agrees'`
        )
        .get()
    ).toEqual({ action: "event.lifecycle_change", actor: null, tt: "event", ca: nowSecs });
  });

  it("a persistent overload is counted WITH its cause — in the result, the run row and the digest line — and changes nothing", async () => {
    seedEvent({ id: "agrees", start: NOV20 });
    (db as unknown as Batchable).batch = async () => {
      throw overloadError();
    };
    const sleeps: number[] = [];
    const r = await runTentativeAutopromote(db, {
      now: NOW,
      fetchPage: fetcherFor({ agrees: AGREE_NOV20 }),
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([2000, 5000]);
    expect(lifecycle("agrees")).toBe("TENTATIVE");
    expect(auditRows("agrees")).toHaveLength(0);
    expect(r.errors).toBe(1);
    expect(r.errorDetails).toEqual([
      { slug: "agrees", pass: "promote", kind: "d1_overload", cause: OVERLOAD },
    ]);
    expect(r.summary).toBe("auto-promoted 0; 0 left for review; 1 error(s) (d1_overload ×1)");

    // The run row — the store that survives an overload — carries the detail.
    const run = raw
      .prepare(
        `SELECT payload_json AS p FROM admin_actions WHERE action = 'event.tentative_autopromote_run'`
      )
      .all() as { p: string }[];
    expect(run).toHaveLength(1);
    expect(JSON.parse(run[0].p).errorDetails).toEqual(r.errorDetails);
  });

  it.each([
    [
      "the audit INSERT (the Shelburne shape)",
      "admin_actions",
      "INSERT",
      "NEW.action = 'event.lifecycle_change'",
    ],
    ["the UPDATE", "events", "UPDATE", "NEW.lifecycle_status = 'SCHEDULED'"],
  ])(
    "a failure in %s rolls BOTH back: the row stays TENTATIVE with no audit row",
    async (_label, table, op, when) => {
      seedEvent({ id: "agrees", start: NOV20 });
      transactionalBatch();
      raw.exec(`
        CREATE TRIGGER t_fail BEFORE ${op} ON ${table}
        WHEN ${when}
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
      const sleeps: number[] = [];
      const r = await runTentativeAutopromote(db, {
        now: NOW,
        fetchPage: fetcherFor({ agrees: AGREE_NOV20 }),
        sleep: async (ms) => void sleeps.push(ms),
      });
      expect(lifecycle("agrees")).toBe("TENTATIVE");
      expect(auditRows("agrees")).toHaveLength(0);
      expect(r.promoted).toEqual([]);
      // Not an overload, so not retried; still explained.
      expect(sleeps).toEqual([]);
      expect(r.errorDetails).toMatchObject([{ slug: "agrees", pass: "promote", kind: "other" }]);
      expect(r.errorDetails[0].cause).toContain("simulated write failure");
    }
  );

  it("writes no audit row when a person moved the row while the fetch was in flight", async () => {
    seedEvent({ id: "agrees", start: NOV20 });
    const fetchPage = (async (url: string) => {
      raw.exec(`UPDATE events SET lifecycle_status = 'CANCELLED' WHERE id = 'agrees'`);
      return fetcherFor({ agrees: AGREE_NOV20 })(url);
    }) as PageFetcher;
    const r = await runTentativeAutopromote(db, { now: NOW, fetchPage });
    expect(lifecycle("agrees")).toBe("CANCELLED");
    expect(auditRows("agrees")).toHaveLength(0);
    expect(r.promoted).toEqual([]);
    expect(r.errors).toBe(0);
  });
});
