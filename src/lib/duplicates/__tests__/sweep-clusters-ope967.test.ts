/**
 * OPE-967 — the duplicate sweep must see pairs that exist only across statuses.
 *
 * Against a real SQLite database: the Brookfield Orchards shape (one APPROVED,
 * one TENTATIVE, same venue and date — both publicly served) was invisible to
 * the APPROVED-only sweep.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { findDuplicateClusters } from "../sweep-clusters";

const SCHEMA_SQL = `
  CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT, city TEXT, state TEXT);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    status TEXT NOT NULL, lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    venue_id TEXT, start_date INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const SEP12 = Math.floor(Date.parse("2026-09-12T12:00:00Z") / 1000);

function venue(id: string, city = "Brookfield", state = "MA") {
  raw
    .prepare(`INSERT INTO venues (id, name, slug, city, state) VALUES (?,?,?,?,?)`)
    .run(id, `V ${id}`, id, city, state);
}
function event(
  id: string,
  status: string,
  venueId: string | null,
  start = SEP12,
  lifecycle = "SCHEDULED"
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, lifecycle_status, venue_id, start_date) VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      id,
      "Brookfield Orchards Harvest Craft Fair",
      `slug-${id}`,
      status,
      lifecycle,
      venueId,
      start
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  venue("v1");
});

describe("OPE-967 — findDuplicateClusters", () => {
  it("BROOKFIELD SHAPE: an APPROVED + TENTATIVE pair at one venue and date is a cluster", async () => {
    event("c1e8273c", "APPROVED", "v1");
    event("77b95478", "TENTATIVE", "v1");
    const r = await findDuplicateClusters(db, 100);
    expect(r.venueDateClusters).toHaveLength(1);
    expect(r.venueDateClusters[0].event_ids.sort()).toEqual(["77b95478", "c1e8273c"]);
  });

  it("POSITIVE LANDMARK: two APPROVED rows still cluster, as before", async () => {
    event("a", "APPROVED", "v1");
    event("b", "APPROVED", "v1");
    expect((await findDuplicateClusters(db, 100)).venueDateClusters).toHaveLength(1);
  });

  it.each(["REJECTED", "PENDING", "DRAFT"])(
    "a %s row beside an APPROVED one is NOT a cluster (not public)",
    async (status) => {
      event("a", "APPROVED", "v1");
      event("b", status, "v1");
      expect((await findDuplicateClusters(db, 100)).clusters).toHaveLength(0);
    }
  );

  it("a CANCELLED-lifecycle row beside a live one is not a cluster — lifecycle is part of the public predicate", async () => {
    event("a", "APPROVED", "v1");
    event("b", "TENTATIVE", "v1", SEP12, "CANCELLED");
    expect((await findDuplicateClusters(db, 100)).clusters).toHaveLength(0);
  });

  it("the city+state query also sees across statuses", async () => {
    venue("v2"); // same city/state, different venue row
    event("a", "APPROVED", "v1");
    event("b", "TENTATIVE", "v2");
    const r = await findDuplicateClusters(db, 100);
    expect(r.venueDateClusters).toHaveLength(0);
    expect(r.filteredCityStateClusters).toHaveLength(1);
  });
});
