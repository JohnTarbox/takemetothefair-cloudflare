/**
 * OPE-1647 — a promoter merge moves EVERY child row to the keeper, on both
 * merge paths, and the preview writes nothing.
 *
 * OPE-1120 fixed only the FK-less tables. The FK children were still lost on
 * the hard delete: `event_series` (and four more) SET NULL, contacts, feeds,
 * outreach, list subscriptions, API keys and refs, import rows CASCADE-deleted.
 * 7 series were found orphaned on 2026-11-12.
 *
 * Runs against the MCP suite's schema (real FK actions on the feed / contact /
 * subscription / import / API tables, loaded from their migrations), so a row
 * that is not moved is really CASCADE-deleted here, as in prod. For the tables
 * whose test DDL carries no FK, the assertion is "the row now names the keeper",
 * which is what the delete cannot undo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  CapturingMcpServer,
  createTestDb,
  mockIndexNowFetch,
} from "../../../../mcp-server/__tests__/setup-db";
import { registerMergeEntitiesTools } from "../../../../mcp-server/src/tools/admin-merge-entities";
import {
  PROMOTER_CHILD_TABLES_ALLOWLISTED,
  PROMOTER_CHILD_TABLES_HANDLED,
} from "@takemetothefair/db-schema";
import * as schema from "@takemetothefair/db-schema";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { executeMerge } from "../merge-operations";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
let mock: ReturnType<typeof mockIndexNowFetch>;

const n = (q: string, ...args: unknown[]) => (raw.prepare(q).get(...args) as { n: number }).n;
const run = (q: string, ...args: unknown[]) => raw.prepare(q).run(...args);

/** Every promoter-child table, and how many of its rows name `id`. */
const CHILD_COUNTS: Array<[string, string]> = [
  ["event_series", "promoter_id"],
  ["inbound_newsletters", "promoter_id"],
  ["promoter_list_arrivals", "promoter_id"],
  ["pending_promoter_contacts", "attached_promoter_id"],
  ["promoter_slug_history", "promoter_id"],
  ["promoter_contacts", "promoter_id"],
  ["promoter_outreach_attempts", "promoter_id"],
  ["promoter_list_subscriptions", "promoter_id"],
  ["promoter_event_feeds", "promoter_id"],
  ["feed_discrepancy_batches", "promoter_id"],
  ["promoter_import_rows", "promoter_id"],
  ["promoter_api_keys", "promoter_id"],
  ["promoter_api_event_refs", "promoter_id"],
];
const rowsFor = (id: string) =>
  Object.fromEntries(
    CHILD_COUNTS.map(([t, c]) => [t, n(`SELECT count(*) n FROM ${t} WHERE ${c}=?`, id)])
  );
/** Whole-table row counts: a preview must leave every one unchanged. */
const ALL_TABLES = [
  ...CHILD_COUNTS.map(([t]) => t),
  "promoters",
  "events",
  "promoter_feed_items",
  "promoter_feed_reads",
  "feed_websub_subscriptions",
  "event_field_pins",
];
const snapshot = () =>
  Object.fromEntries(ALL_TABLES.map((t) => [t, n(`SELECT count(*) n FROM ${t}`)])) as Record<
    string,
    number
  >;

function seed() {
  run(
    `INSERT INTO promoters (id, company_name, slug, contact_email, website) VALUES
       ('keeper', 'Great Home Expo', 'great-home-expo', 'info@greathomeexpo.com', 'https://greathomeexpo.com'),
       ('loser', 'The Maine Home Show', 'the-maine-home-show', 'other@x.com', 'https://mainehomeshow.com'),
       ('heir', 'Old Name Co', 'old-name-co', NULL, NULL)`
  );
  // Harvest candidates: the keeper lacks a phone, city and description.
  run(
    `UPDATE promoters SET contact_phone='207-555-0100', city='Portland', state='ME',
       description='Home shows in Maine' WHERE id='loser'`
  );
  run(`UPDATE promoters SET state='NH' WHERE id='keeper'`);
  run(`UPDATE promoters SET succeeded_by_promoter_id='loser' WHERE id='heir'`);

  run(`INSERT INTO events (id, name, slug, promoter_id) VALUES ('e1','Show','show-2027','loser')`);
  run(
    `INSERT INTO event_series (id, canonical_slug, name, promoter_id) VALUES ('s1','maine-home-show','Maine Home Show','loser')`
  );
  run(`UPDATE events SET series_id='s1' WHERE id='e1'`);
  run(
    `INSERT INTO inbound_emails (id, received_at, from_address, to_address, intent, created_at) VALUES
       ('ie1',0,'a@b.c','x@y.z','submit',0), ('ie2',0,'a@b.c','x@y.z','submit',0)`
  );
  run(
    `INSERT INTO inbound_newsletters (id, inbound_email_id, markers, match_basis, promoter_id, created_at)
     VALUES ('nl1','ie1','[]','sender-domain','loser',0)`
  );
  run(
    `INSERT INTO pending_promoter_contacts (id, email, org_domain, status, attached_promoter_id, first_validated_at, created_at, updated_at)
     VALUES ('ppc1','ann@mainehomeshow.com','mainehomeshow.com','attached','loser',0,0,0)`
  );
  run(
    `INSERT INTO promoter_slug_history (id, promoter_id, old_slug, new_slug, changed_at)
     VALUES ('sh1','loser','maine-home-show-llc','the-maine-home-show',0)`
  );

  // Contacts: one unique to the loser, one the keeper also holds (collision).
  run(
    `INSERT INTO promoter_contacts (id, promoter_id, email, validation_method, created_at, updated_at) VALUES
       ('c-k-shared','keeper','shared@greathomeexpo.com','domain_verified',0,0),
       ('c-l-shared','loser','shared@greathomeexpo.com','domain_verified',0,0),
       ('c-l-own','loser','ann@mainehomeshow.com','domain_verified',0,0)`
  );
  run(
    `INSERT INTO feed_discrepancy_batches (id, promoter_id, contact_id, discrepancy_ids, composed_at)
     VALUES ('b1','loser','c-l-shared','[]',0)`
  );
  run(
    `INSERT INTO event_field_pins (id, event_id, field_name, pinned_value, contact_id, created_at, updated_at)
     VALUES ('pin1','e1','start_date','2027-01-01','c-l-shared',0,0)`
  );

  run(
    `INSERT INTO promoter_outreach_attempts (id, promoter_id, to_address, subject, body_text, created_at)
     VALUES ('oa1','loser','ann@mainehomeshow.com','Hi','Hello',0)`
  );

  // List subscriptions: one shared address (collision) with an arrival on the loser's row.
  run(
    `INSERT INTO promoter_list_subscriptions (id, promoter_id, address, requested_at, created_at, updated_at) VALUES
       ('ls-k','keeper','list@greathomeexpo.com',0,0,0),
       ('ls-l','loser','list@greathomeexpo.com',0,0,0),
       ('ls-l-own','loser','news@mainehomeshow.com',0,0,0)`
  );
  run(
    `INSERT INTO promoter_list_arrivals (id, inbound_email_id, promoter_id, match_basis, kind, subscription_id, created_at)
     VALUES ('la1','ie2','loser','subscription-address','issue','ls-l',0)`
  );

  // Feeds: one unique, one sharing a URL with the keeper's feed (collision).
  run(
    `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, created_at, updated_at) VALUES
       ('f-k','keeper','https://greathomeexpo.com/events/feed',0,0),
       ('f-l','loser','https://greathomeexpo.com/events/feed',0,0),
       ('f-l-own','loser','https://mainehomeshow.com/ical',0,0)`
  );
  run(
    `INSERT INTO promoter_feed_items (id, feed_id, external_id, first_seen_at, last_seen_at) VALUES
       ('fi-k-a','f-k','a',0,0),
       ('fi-l-a','f-l','a',0,0),
       ('fi-l-b','f-l','b',0,0),
       ('fi-own','f-l-own','z',0,0)`
  );
  run(
    `INSERT INTO promoter_feed_reads (id, feed_id, started_at, triggered_by, outcome) VALUES ('fr1','f-l',0,'schedule','ok')`
  );
  run(
    `INSERT INTO feed_websub_subscriptions (id, feed_id, hub_url, topic_url, secret, created_at, updated_at)
     VALUES ('ws1','f-l','https://hub','https://topic','s',0,0)`
  );

  run(
    `INSERT INTO promoter_import_rows (id, promoter_id, file_hash, row_number, outcome, row_values, channel, created_at) VALUES
       ('ir-k','keeper','h1',1,'created','{}','portal',0),
       ('ir-l','loser','h1',1,'created','{}','portal',0),
       ('ir-l-own','loser','h2',1,'created','{}','portal',0)`
  );
  run(
    `INSERT INTO promoter_api_keys (id, promoter_id, name, key_id, secret, created_at)
     VALUES ('k1','loser','Website','mmk_loser','s',0)`
  );
  run(
    `INSERT INTO promoter_api_event_refs (id, promoter_id, external_id, created_at, updated_at) VALUES
       ('r-k','keeper','EXT-1',0,0),
       ('r-l','loser','EXT-1',0,0),
       ('r-l-own','loser','EXT-2',0,0)`
  );
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  // The 0411 DDL is loaded by createTestDb (OPE-1647).
  // The app path also moves favourites; the MCP harness has no such table.
  raw["exec"](
    `CREATE TABLE IF NOT EXISTS user_favorites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
       favoritable_type TEXT NOT NULL, favoritable_id TEXT NOT NULL, created_at INTEGER)`
  );
  mock = mockIndexNowFetch();
  seed();
});
afterEach(() => mock.restore());

async function mcpMerge(extra: Record<string, unknown> = {}) {
  const server = new CapturingMcpServer();
  registerMergeEntitiesTools(server as never, db as never, { userId: "u-admin", role: "ADMIN" });
  const r = (await server.invoke("merge_promoter", {
    keeper_promoter_id: "keeper",
    duplicate_promoter_id: "loser",
    ...extra,
  })) as { isError?: boolean; content: Array<{ text: string }> };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

/** What every merge, on either path, must leave behind. */
function expectEverythingOnTheKeeper() {
  expect(n(`SELECT count(*) n FROM promoters WHERE id='loser'`)).toBe(0);
  // Nothing names the loser any more…
  for (const [t, v] of Object.entries(rowsFor("loser"))) expect([t, v]).toEqual([t, 0]);
  // …and nothing was lost: every loser row that had no keeper twin is on the keeper.
  expect(rowsFor("keeper")).toEqual({
    event_series: 1,
    inbound_newsletters: 1,
    promoter_list_arrivals: 1,
    pending_promoter_contacts: 1,
    promoter_slug_history: expect.any(Number),
    promoter_contacts: 2, // keeper's shared + loser's own (loser's shared dropped)
    promoter_outreach_attempts: 1,
    promoter_list_subscriptions: 2,
    promoter_event_feeds: 2,
    feed_discrepancy_batches: 1,
    promoter_import_rows: 2,
    promoter_api_keys: 1,
    promoter_api_event_refs: 2,
  });
  // The ticket's acceptance query.
  expect(
    n(`SELECT count(*) n FROM event_series s WHERE s.promoter_id IS NULL
       AND EXISTS (SELECT 1 FROM events e WHERE e.series_id = s.id)`)
  ).toBe(0);
  // Grandchildren of dropped twins followed them to the keeper's row.
  expect(n(`SELECT count(*) n FROM feed_discrepancy_batches WHERE contact_id='c-k-shared'`)).toBe(
    1
  );
  expect(n(`SELECT count(*) n FROM event_field_pins WHERE contact_id='c-k-shared'`)).toBe(1);
  expect(n(`SELECT count(*) n FROM promoter_list_arrivals WHERE subscription_id='ls-k'`)).toBe(1);
  // Feed items: the loser feed's non-duplicate item and its read history moved.
  expect(
    raw.prepare(`SELECT id FROM promoter_feed_items WHERE feed_id='f-k' ORDER BY id`).all()
  ).toEqual([{ id: "fi-k-a" }, { id: "fi-l-b" }]);
  expect(n(`SELECT count(*) n FROM promoter_feed_items WHERE id='fi-own'`)).toBe(1);
  expect(n(`SELECT count(*) n FROM promoter_feed_reads WHERE feed_id='f-k'`)).toBe(1);
  // The loser's old renames now redirect to the keeper in one hop.
  expect(
    raw.prepare(`SELECT promoter_id p, new_slug s FROM promoter_slug_history WHERE id='sh1'`).get()
  ).toEqual({
    p: "keeper",
    s: "great-home-expo",
  });
  // A successor pointer at the loser now names the keeper.
  expect(
    raw.prepare(`SELECT succeeded_by_promoter_id s FROM promoters WHERE id='heir'`).get()
  ).toEqual({
    s: "keeper",
  });
  // Field harvest: only the keeper's EMPTY fields were filled.
  expect(
    raw
      .prepare(
        `SELECT contact_email, website, contact_phone, city, state, description FROM promoters WHERE id='keeper'`
      )
      .get()
  ).toEqual({
    contact_email: "info@greathomeexpo.com",
    website: "https://greathomeexpo.com",
    contact_phone: "207-555-0100",
    city: "Portland",
    state: "NH",
    description: "Home shows in Maine",
  });
}

describe("OPE-1647 — merge_promoter (MCP path)", () => {
  it("landmark: the loser really has a row in every child table", () => {
    for (const [t, v] of Object.entries(rowsFor("loser"))) expect([t, v > 0]).toEqual([t, true]);
  });

  it("with no preview argument, writes NOTHING and returns the full transfer report", async () => {
    const before = snapshot();
    const loserBefore = rowsFor("loser");
    const r = await mcpMerge();
    expect(snapshot()).toEqual(before);
    expect(rowsFor("loser")).toEqual(loserBefore);
    expect(n(`SELECT count(*) n FROM promoters WHERE id='loser'`)).toBe(1);
    expect(r.preview).toBe(true);
    expect(r.merged).toBe(false);
    expect(r.events_to_reassign).toBe(1);
    expect(r.children.preview).toBe(true);
    expect(r.children.tables.event_series).toEqual({ moved: 1, droppedAsDuplicate: 0, deleted: 0 });
    expect(r.children.tables.promoter_contacts).toEqual({
      moved: 1,
      droppedAsDuplicate: 1,
      deleted: 0,
    });
    expect(r.children.fieldsHarvested.map((f: { column: string }) => f.column).sort()).toEqual([
      "city",
      "contactPhone",
      "description",
    ]);
  });

  it("preview: false moves every child to the keeper and names every collision", async () => {
    const r = await mcpMerge({ preview: false });
    expect(r.merged).toBe(true);
    expectEverythingOnTheKeeper();
    expect(
      r.children.collisions
        .map((c: { table: string; loserRowId: string; keeperRowId: string }) =>
          [c.table, c.loserRowId, c.keeperRowId].join(":")
        )
        .sort()
    ).toEqual([
      "promoter_api_event_refs:r-l:r-k",
      "promoter_contacts:c-l-shared:c-k-shared",
      "promoter_event_feeds:f-l:f-k",
      "promoter_import_rows:ir-l:ir-k",
      "promoter_list_subscriptions:ls-l:ls-k",
    ]);
    expect(r.children.warnings.join(" ")).toMatch(/1 feed item\(s\)/);
    expect(r.children.tables.feed_websub_subscriptions).toEqual({
      moved: 0,
      droppedAsDuplicate: 0,
      deleted: 1,
    });
  });

  it("the preview and the real merge report from the same plan", async () => {
    const p = await mcpMerge();
    const r = await mcpMerge({ preview: false });
    expect({ ...r.children, preview: true }).toEqual(p.children);
  });
});

describe("OPE-1647 — /api/admin/duplicates/merge (app path)", () => {
  it("moves every child to the keeper, the same as the MCP tool", async () => {
    const res = await executeMerge(db as never, "promoters", "keeper", "loser", "u-admin");
    expect(res.success).toBe(true);
    expectEverythingOnTheKeeper();
  });
});

describe("OPE-1647 — schema coverage: every promoter reference is handled", () => {
  /** Every column that references promoters, by FK or by name. */
  function promoterReferences(): string[] {
    const refs = new Set<string>();
    for (const v of Object.values(schema)) {
      if (!is(v, SQLiteTable)) continue;
      const cfg = getTableConfig(v as SQLiteTable);
      for (const fk of cfg.foreignKeys) {
        const r = fk.reference();
        if (getTableConfig(r.foreignTable).name === "promoters")
          for (const c of r.columns) refs.add(`${cfg.name}.${c.name}`);
      }
      // By name too: inbound_newsletters / promoter_list_arrivals carry a live
      // SET NULL FK that the Drizzle schema does not declare.
      for (const c of cfg.columns)
        if (/promoter_id$/.test(c.name)) refs.add(`${cfg.name}.${c.name}`);
    }
    return [...refs].sort();
  }

  it("landmark: the enumeration finds the known references", () => {
    const refs = promoterReferences();
    expect(refs.length).toBeGreaterThanOrEqual(16);
    expect(refs).toContain("event_series.promoter_id");
    expect(refs).toContain("inbound_newsletters.promoter_id");
    expect(refs).toContain("promoters.succeeded_by_promoter_id");
  });

  it("every reference is repointed by repointPromoterChildren or allowlisted with a reason", () => {
    const handled = new Set<string>([
      ...PROMOTER_CHILD_TABLES_HANDLED,
      ...Object.keys(PROMOTER_CHILD_TABLES_ALLOWLISTED),
    ]);
    const unhandled = promoterReferences().filter((r) => !handled.has(r));
    expect(unhandled).toEqual([]);
  });

  it("…and the check fails when a new promoter-referencing table is not handled", () => {
    const fake = [...promoterReferences(), "promoter_new_intake.promoter_id"];
    const handled = new Set<string>([
      ...PROMOTER_CHILD_TABLES_HANDLED,
      ...Object.keys(PROMOTER_CHILD_TABLES_ALLOWLISTED),
    ]);
    expect(fake.filter((r) => !handled.has(r))).toEqual(["promoter_new_intake.promoter_id"]);
  });

  it("the handled list names nothing that no longer exists", () => {
    const refs = new Set(promoterReferences());
    expect(PROMOTER_CHILD_TABLES_HANDLED.filter((h) => !refs.has(h))).toEqual([]);
  });
});
