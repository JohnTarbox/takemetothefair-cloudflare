/**
 * OPE-815 (09-23 bounce) — the radar, end to end on a real sqlite db.
 *
 *   1. The four past Truro occurrences were re-stamped daily: a past event's
 *      open radar row closes (superseded_by_lifecycle / post_event) and its
 *      finding is never lifted again.
 *   2. Jenks a3f3f653 was closed 22:03 and re-opened as ecd88d5e at 06:02:
 *      the unresolved FINDING was lifted again. An adjudicated fact is skipped.
 *   3. Drift magnitude is a queryable column, not only prose in `notes`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { runScheduledStalePageRadar } from "../src/goodwill/stale-page-radar.js";
import { detectChallengePage } from "@takemetothefair/site-fetch";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function seedEvent(id: string, startOffsetDays: number) {
  const start = now() + startOffsetDays * DAY;
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, status, start_date, end_date) VALUES (?, ?, ?, 'p', 'APPROVED', ?, ?)"
    )
    .run(id, id, id, start, start);
  return start;
}
function seedFinding(
  id: string,
  eventId: string,
  stored: number,
  canonicalOffsetDays: number,
  url: string
) {
  raw
    .prepare(
      "INSERT INTO event_date_drift_findings (id, event_id, stored_start_date, canonical_start_date, drift_days, canonical_url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, eventId, stored, stored + canonicalOffsetDays * DAY, canonicalOffsetDays, url, now());
}
const rows = (eventId: string) =>
  raw
    .prepare(
      "SELECT resolution_status, resolution_source, drift_days FROM event_discrepancies WHERE event_id = ?"
    )
    .all(eventId) as Array<{
    resolution_status: string;
    resolution_source: string | null;
    drift_days: number | null;
  }>;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.prepare("INSERT INTO users (id, email, role) VALUES ('u','a@x','ADMIN')").run();
  raw
    .prepare("INSERT INTO promoters (id, company_name, slug, user_id) VALUES ('p','P','p','u')")
    .run();
});

describe("OPE-815 radar rework", () => {
  it("a FUTURE event's finding is lifted, with drift_days as a column", async () => {
    const s = seedEvent("future", 30);
    seedFinding("f1", "future", s, 366, "https://jenks.example/expo");
    const r = await runScheduledStalePageRadar(db as never);
    expect(r.emitted).toBe(1);
    expect(rows("future")).toEqual([
      { resolution_status: "open", resolution_source: null, drift_days: 366 },
    ]);
  });

  it("a PAST event's finding is never lifted, and its open row is closed", async () => {
    const s = seedEvent("truro-jul-9", -30);
    seedFinding("f2", "truro-jul-9", s, 14, "https://capecodchamber.example/51319/");
    raw
      .prepare(
        "INSERT INTO event_discrepancies (id, event_id, field_class, detected_by, detected_at, resolution_status) VALUES ('d-old','truro-jul-9','date','stale_page_radar',?, 'open')"
      )
      .run(now() - 40 * DAY);
    const r = await runScheduledStalePageRadar(db as never);
    expect(r.emitted).toBe(0);
    expect(r.closed_past).toBe(1);
    expect(rows("truro-jul-9")).toEqual([
      {
        resolution_status: "superseded_by_lifecycle",
        resolution_source: "post_event",
        drift_days: null,
      },
    ]);
  });

  it("an ADJUDICATED fact is not re-opened the next morning (the Jenks shape)", async () => {
    const s = seedEvent("jenks", 50);
    seedFinding("f3", "jenks", s, 366, "https://jenks.example/expo");
    await runScheduledStalePageRadar(db as never); // opens
    raw
      .prepare(
        "UPDATE event_discrepancies SET resolution_status='resolved_authoritative', resolution_source='higher_tier' WHERE event_id='jenks'"
      )
      .run();
    const r2 = await runScheduledStalePageRadar(db as never); // next morning
    expect(r2.emitted).toBe(0);
    expect(r2.skipped_adjudicated).toBe(1);
    expect(rows("jenks")).toHaveLength(1);
  });

  it("a DIFFERENT divergent date on the same event is still a new finding", async () => {
    const s = seedEvent("jenks2", 50);
    seedFinding("f4", "jenks2", s, 366, "https://jenks.example/expo");
    await runScheduledStalePageRadar(db as never);
    raw
      .prepare(
        "UPDATE event_discrepancies SET resolution_status='dismissed' WHERE event_id='jenks2'"
      )
      .run();
    raw
      .prepare(
        "UPDATE event_date_drift_findings SET canonical_start_date = canonical_start_date + ? WHERE id='f4'"
      )
      .run(7 * DAY);
    const r = await runScheduledStalePageRadar(db as never);
    expect(r.emitted).toBe(1);
  });
});

describe("SiteGround sgcaptcha interstitial", () => {
  it("is recognised as a challenge page, not a source", () => {
    const html = `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>`;
    expect(detectChallengePage(html).isChallenge).toBe(true);
  });
});

describe("a dateless event is not 'past'", () => {
  it("its finding is still lifted (NULL must not turn NOT(...) into NULL)", async () => {
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, status) VALUES ('nodate','n','n','p','APPROVED')"
      )
      .run();
    seedFinding("f9", "nodate", now(), 7, "https://organizer.example/");
    const r = await runScheduledStalePageRadar(db as never);
    expect(r.emitted).toBe(1);
  });
});
