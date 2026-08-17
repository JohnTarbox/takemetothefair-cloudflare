/**
 * OPE-424 — "which published events have a source we can't read?"
 *
 * The headline test is `the last_synced_at trap`. It documents why this query
 * exists at all: the obvious implementation (`last_synced_at IS NULL`) returns
 * nothing useful, because that column is stamped at row CREATION by five
 * different writers. In production every approved http://-sourced event has a
 * non-null `last_synced_at` equal to its `created_at` to the second — the
 * column reads as "we synced this" and means "this row exists".
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { getUnreachableSourceEvents, summarizeUnreachableSources } from "../source-reachability";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    status TEXT NOT NULL, source_url TEXT, source_domain TEXT,
    last_synced_at INTEGER, created_at INTEGER, updated_at INTEGER,
    merged_into TEXT
  );
  CREATE TABLE enrichment_log (
    id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    source TEXT NOT NULL, status TEXT NOT NULL, attempted_at INTEGER NOT NULL,
    finished_at INTEGER, fields_changed TEXT, notes TEXT, actor_user_id TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seedEvent(
  id: string,
  opts: { url?: string | null; domain?: string; status?: string; synced?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, source_url, source_domain, last_synced_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      `Event ${id}`,
      `event-${id}`,
      opts.status ?? "APPROVED",
      opts.url === undefined ? `http://${opts.domain ?? "organizer.test"}/fairs` : opts.url,
      opts.domain ?? "organizer.test",
      opts.synced ? T(opts.synced) : T("2026-01-01T00:00:00Z"),
      T("2026-01-01T00:00:00Z")
    );
}

function seedLog(id: string, eventId: string, status: string, iso: string, notes = "") {
  raw
    .prepare(
      `INSERT INTO enrichment_log (id, target_type, target_id, source, status, attempted_at, notes)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, "event", eventId, "scraper", status, T(iso), notes);
}

describe("the last_synced_at trap", () => {
  it("finds an unreachable source even though last_synced_at is NOT null", async () => {
    // Exactly the production shape: the row was stamped at creation, so a
    // `last_synced_at IS NULL` filter would report zero problems while the
    // organizer's site has never been readable.
    seedEvent("e1", { domain: "islandartsassociation.com", synced: "2026-01-01T00:00:00Z" });
    seedLog("l1", "e1", "failure", "2026-08-16T00:00:00Z", "self-signed certificate");

    const rows = await getUnreachableSourceEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceDomain).toBe("islandartsassociation.com");
    expect(rows[0].everFetchedOk).toBe(false);
    expect(rows[0].isPlainHttp).toBe(true);
  });
});

describe("resolution", () => {
  it("drops an event whose failure was followed by a success", async () => {
    seedEvent("e1");
    seedLog("l1", "e1", "failure", "2026-08-01T00:00:00Z");
    seedLog("l2", "e1", "success", "2026-08-10T00:00:00Z");
    expect(await getUnreachableSourceEvents(db)).toHaveLength(0);
  });

  it("keeps an event that failed AFTER its last success — a regression", async () => {
    seedEvent("e1");
    seedLog("l1", "e1", "success", "2026-08-01T00:00:00Z");
    seedLog("l2", "e1", "failure", "2026-08-10T00:00:00Z");
    const rows = await getUnreachableSourceEvents(db);
    expect(rows).toHaveLength(1);
    // It HAS been fetched before, which is a different operator story from
    // "never readable" — so the flag is reported, not just the row.
    expect(rows[0].everFetchedOk).toBe(true);
  });

  it("ignores events with only successes", async () => {
    seedEvent("e1");
    seedLog("l1", "e1", "success", "2026-08-10T00:00:00Z");
    expect(await getUnreachableSourceEvents(db)).toHaveLength(0);
  });
});

describe("scope", () => {
  it("only reports published events — a rejected row's source is nobody's problem", async () => {
    seedEvent("e1", { status: "REJECTED" });
    seedLog("l1", "e1", "failure", "2026-08-16T00:00:00Z");
    expect(await getUnreachableSourceEvents(db)).toHaveLength(0);
  });

  it("ignores events with no source URL at all", async () => {
    seedEvent("e1", { url: null });
    seedLog("l1", "e1", "failure", "2026-08-16T00:00:00Z");
    expect(await getUnreachableSourceEvents(db)).toHaveLength(0);
  });

  it("flags an https source too — this is not only a plain-HTTP problem", async () => {
    seedEvent("e1", { url: "https://organizer.test/fairs", domain: "organizer.test" });
    seedLog("l1", "e1", "failure", "2026-08-16T00:00:00Z");
    const rows = await getUnreachableSourceEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].isPlainHttp).toBe(false);
  });
});

describe("digest summary", () => {
  it("returns null on a clean result rather than a row of zeros", async () => {
    expect(summarizeUnreachableSources([])).toBeNull();
  });

  it("counts hosts, never-fetched and plain-HTTP separately", async () => {
    seedEvent("e1", { domain: "a.test" });
    seedEvent("e2", { domain: "b.test" });
    seedLog("l1", "e1", "failure", "2026-08-16T00:00:00Z");
    seedLog("l2", "e2", "failure", "2026-08-16T00:00:00Z");
    const line = summarizeUnreachableSources(await getUnreachableSourceEvents(db));
    expect(line).toContain("2 published events across 2 source hosts");
    expect(line).toContain("2 never fetched successfully");
    expect(line).toContain("2 on plain HTTP");
  });
});
