/**
 * OPE-617 — "has hours" was a presence test.
 *
 * The regression case is named in the ticket: under the corrected definition,
 * Windsor Fair and Hopkinton State Fair must both read as MISSING public hours
 * in their pre-repair shape. Under the old `COUNT(event_days) = 0` test they
 * both read as covered.
 *
 * Both fixtures are the real pre-repair rows:
 *
 *   Windsor Fair    Aug 29 – Sep 7 2026 (10 days), ONE row dated 2026-08-27 —
 *                   two days BEFORE it opens — vendor_only = 1
 *   Hopkinton       Sep 3 – Sep 7 2026 (5 days), ONE row dated 2025-08-28 —
 *                   LAST YEAR — vendor_only = 1
 *
 * The negative cases matter as much: the ticket's own first framing was
 * `day_rows < span_days`, which it measured as 20/23 FALSE against live data
 * and asked explicitly not to be built. Winter farmers' markets and the
 * Renaissance faires are legitimately intermittent, and a metric that flags
 * them is worse than the one being replaced.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { readDayCoverage } from "../src/events/day-coverage.js";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'APPROVED',
    merged_into TEXT,
    start_date INTEGER,
    end_date INTEGER
  );
  CREATE TABLE event_days (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    date TEXT NOT NULL,
    vendor_only INTEGER NOT NULL DEFAULT 0
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Days from now, as a unix second — everything here must be UPCOMING. */
const inDays = (n: number) => Math.floor(Date.now() / 1000) + n * 86400;
const dateStr = (n: number) => new Date(inDays(n) * 1000).toISOString().slice(0, 10);

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seedEvent(slug: string, startInDays: number, endInDays: number) {
  raw
    .prepare(`INSERT INTO events (id, slug, name, start_date, end_date) VALUES (?,?,?,?,?)`)
    .run(slug, slug, slug, inDays(startInDays), inDays(endInDays));
}
function seedDay(slug: string, dayOffset: number, vendorOnly = 0) {
  raw
    .prepare(`INSERT INTO event_days (id, event_id, date, vendor_only) VALUES (?,?,?,?)`)
    .run(`${slug}-${dayOffset}-${vendorOnly}`, slug, dateStr(dayOffset), vendorOnly);
}

const read = () => readDayCoverage(db as never);

describe("OPE-617 — the two live specimens, in their pre-repair shape", () => {
  it("Windsor Fair: one vendor-only row dated BEFORE the fair opens is not hours", async () => {
    // 10-day run; the only row is two days early and vendor-only.
    seedEvent("windsor-fair", 1, 10);
    seedDay("windsor-fair", -1, 1);
    const c = await read();
    expect(c.no_public_days).toBe(1);
    expect(c.out_of_span_days).toBe(1);
  });

  it("Hopkinton: one vendor-only row dated LAST YEAR is not hours", async () => {
    seedEvent("hopkinton-state-fair", 6, 10);
    seedDay("hopkinton-state-fair", -360, 1);
    const c = await read();
    expect(c.no_public_days).toBe(1);
    expect(c.out_of_span_days).toBe(1);
  });

  it("the OLD presence test would have passed both — that is the point", async () => {
    // Pinning the contrast the ticket rests on. Both events HAVE a day row, so
    // `COUNT(event_days) = 0` is false for each and the old metric scored them
    // covered. The corrected one flags both.
    seedEvent("windsor-fair", 1, 10);
    seedDay("windsor-fair", -1, 1);
    seedEvent("hopkinton-state-fair", 6, 10);
    seedDay("hopkinton-state-fair", -360, 1);
    const rows = raw.prepare(`SELECT COUNT(*) n FROM event_days`).get() as { n: number };
    expect(rows.n).toBe(2); // the old test sees rows and says "fine"
    expect((await read()).no_public_days).toBe(2);
  });
});

describe("what must NOT be flagged", () => {
  it("a repaired fair with real public days is clean", async () => {
    // Windsor after the OPE-605 repair: 10 public in-span rows.
    seedEvent("windsor-fair", 1, 10);
    for (let d = 1; d <= 10; d++) seedDay("windsor-fair", d, 0);
    const c = await read();
    expect(c.no_public_days).toBe(0);
    expect(c.out_of_span_days).toBe(0);
  });

  it("a weekends-only run is NOT flagged — the framing the ticket forbade", async () => {
    // A winter farmers' market: 168-day span, ~24 weekly rows. Under
    // `day_rows < span_days` this is a screaming false positive, and 20 of the
    // ticket's 23 matches were this shape. Under the shipped definition it is
    // clean, because it has public in-span rows.
    seedEvent("winter-farmers-market", 1, 168);
    for (let w = 0; w < 24; w++) seedDay("winter-farmers-market", 1 + w * 7, 0);
    const c = await read();
    expect(c.no_public_days).toBe(0);
    expect(c.out_of_span_days).toBe(0);
  });

  it("an event with NO day rows at all is not counted here", async () => {
    // That is the ORIGINAL no_hours case and a different worklist. Counting it
    // here would double-report it and make the new signal unreadable.
    seedEvent("no-days-at-all", 1, 3);
    expect((await read()).no_public_days).toBe(0);
  });

  it("a past event is out of scope — a finished fair's schedule cannot be acted on", async () => {
    seedEvent("last-year", -400, -395);
    seedDay("last-year", -500, 1);
    const c = await read();
    expect(c.no_public_days).toBe(0);
    expect(c.out_of_span_days).toBe(0);
  });

  it("a merged tombstone is excluded", async () => {
    seedEvent("tombstone", 1, 5);
    seedDay("tombstone", -2, 1);
    raw.prepare(`UPDATE events SET merged_into = 'keeper' WHERE id = 'tombstone'`).run();
    expect((await read()).no_public_days).toBe(0);
  });
});

describe("the two signals are counted apart", () => {
  it("an out-of-span row on an otherwise-covered event flags only out_of_span", async () => {
    // shaker-hill-apple-festival-2026's real shape: 3 rows, 1 out of span, 2
    // public in-span. The schedule renders fine; the stray row is still wrong.
    seedEvent("shaker-hill", 1, 3);
    seedDay("shaker-hill", 1, 0);
    seedDay("shaker-hill", 2, 0);
    seedDay("shaker-hill", -30, 0);
    const c = await read();
    expect(c.out_of_span_days).toBe(1);
    expect(c.no_public_days).toBe(0);
  });

  it("an in-span but vendor-only-only event flags no_public_days, not out_of_span", async () => {
    // Present, in-span, and still renders nothing to the public.
    seedEvent("vendor-only-run", 1, 3);
    seedDay("vendor-only-run", 2, 1);
    const c = await read();
    expect(c.no_public_days).toBe(1);
    expect(c.out_of_span_days).toBe(0);
  });
});
