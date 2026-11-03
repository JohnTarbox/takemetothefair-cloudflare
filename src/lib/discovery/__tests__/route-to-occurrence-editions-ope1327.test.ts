/**
 * OPE-1327 — submit routing on a MULTI-EDITION series: a second same-year
 * edition is CREATED (key free, nothing within ±7 days) or STAGED
 * (edition-ambiguous, naming the edition it collided with) — never dropped.
 *
 * The web submit route and the inbound-email pipeline (which posts to it) both
 * route through maybeRouteToOccurrence; this drives it with the REAL
 * createOccurrenceForSeries against the MCP suite's full schema. Only
 * findDuplicate (path 2) is stubbed to "no match", so path 1 — the name+venue
 * series match, where the silent drop lived — is what runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("@/lib/duplicates/find-duplicate", () => ({
  findDuplicate: vi.fn(async () => ({ isDuplicate: false })),
}));

import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";
import { maybeRouteToOccurrence } from "../route-to-occurrence";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

beforeEach(() => {
  ({ raw, db } = createTestDb());
  raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'NEAR', 'near')`).run();
  raw
    .prepare(
      `INSERT INTO venues (id, name, slug) VALUES ('v1', 'Deerfield Fairgrounds', 'deerfield')`
    )
    .run();
});
afterEach(() => raw.close());

function seedSeries(id: string, mode: "annual" | "multi") {
  raw
    .prepare(
      `INSERT INTO event_series (id, canonical_slug, name, promoter_id, venue_id, edition_mode) VALUES (?, ?, 'NEAR-Fest', 'p1', 'v1', ?)`
    )
    .run(id, `${id}-hub`, mode);
}
function seedMember(id: string, seriesId: string, startIso: string, key: string | null) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, promoter_id, venue_id, series_id, start_date, end_date, status, edition_key)
       VALUES (?, 'NEAR-Fest', ?, 'p1', 'v1', ?, ?, ?, 'APPROVED', ?)`
    )
    .run(id, id, seriesId, sec(startIso), sec(startIso), key);
}
const submit = (startIso: string) =>
  maybeRouteToOccurrence(db as never, {
    name: "NEAR-Fest",
    venueId: "v1",
    startDate: new Date(startIso),
    endDate: new Date(startIso),
  });
const eventCount = () => (raw.prepare("SELECT count(*) n FROM events").get() as { n: number }).n;

describe("multi-edition series", () => {
  it("October after May (same year, key free, months apart) → CREATED as 2027-10", async () => {
    seedSeries("s", "multi");
    seedMember("may", "s", "2027-05-15T16:00:00Z", "2027-05");
    const r = await submit("2027-10-01T16:00:00Z");
    expect(r).toMatchObject({ routed: true, result: { created: true, editionKey: "2027-10" } });
    expect(eventCount()).toBe(2); // landmark: a row was WRITTEN, not just reported
  });

  it("the same edition resubmitted (key held) → STAGED edition-ambiguous, not routed:true", async () => {
    seedSeries("s", "multi");
    seedMember("may", "s", "2027-05-15T16:00:00Z", "2027-05");
    const r = await submit("2027-05-29T16:00:00Z");
    expect(r).toEqual({
      routed: false,
      staged: "edition-ambiguous",
      seriesId: "s",
      editionKey: "2027-05",
      nearEditionId: "may",
    });
    expect(eventCount()).toBe(1); // the caller inserts the reviewed standalone
  });

  it("within ±7 days of an edition across a month boundary → STAGED (dates-changed resubmission)", async () => {
    seedSeries("s", "multi");
    seedMember("may", "s", "2027-05-29T16:00:00Z", "2027-05");
    const r = await submit("2027-06-02T16:00:00Z"); // key 2027-06 is free, but 4 days away
    expect(r).toMatchObject({ routed: false, staged: "edition-ambiguous", nearEditionId: "may" });
  });

  it("NEVER returns routed:true without a write (the OPE-1315 silent drop)", async () => {
    seedSeries("s", "multi");
    seedMember("may", "s", "2027-05-15T16:00:00Z", "2027-05");
    for (const iso of ["2027-05-15T16:00:00Z", "2027-05-20T16:00:00Z", "2027-10-01T16:00:00Z"]) {
      const before = eventCount();
      const r = await submit(iso);
      if (r.routed) {
        expect(r.result.created, iso).toBe(true);
        expect(eventCount(), iso).toBe(before + 1);
      }
    }
  });
});

describe("annual series — unchanged", () => {
  it("a same-year resubmission still answers occurrence_exists (routed, no write)", async () => {
    seedSeries("a", "annual");
    seedMember("y27", "a", "2027-08-01T16:00:00Z", null);
    const r = await submit("2027-08-02T16:00:00Z");
    expect(r).toMatchObject({
      routed: true,
      result: { created: false, reason: "occurrence_exists" },
    });
  });
});
