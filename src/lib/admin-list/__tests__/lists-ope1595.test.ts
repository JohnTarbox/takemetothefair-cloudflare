/**
 * OPE-1595 — the shared admin list, run against a real SQLite database so the
 * generated SQL (correlated counts, NULL ordering, filters) actually executes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { D1_MAX_BIND_PARAMS } from "@takemetothefair/utils";
import * as schema from "../../db/schema";
import {
  blogPosts,
  contentLinks,
  eventDuplicateDismissals,
  eventVendors,
  events,
  performers,
  promoters,
  users,
  vendors,
  venues,
} from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { eventList, performerList, promoterList, userList, vendorList, venueList } from "../lists";
import { isPagedRequest, parseListParams, toCsv } from "../params";
import { runCsvRows, runList } from "../run-list";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;
let db: AppDb;
let prepared: string[];

function run(sqlText: string, ...args: unknown[]) {
  raw.prepare(sqlText).run(...args);
}

function sp(query = ""): URLSearchParams {
  return new URLSearchParams(query);
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [
    users,
    vendors,
    promoters,
    venues,
    events,
    eventVendors,
    contentLinks,
    blogPosts,
    performers,
    eventDuplicateDismissals,
  ]) {
    raw.exec(ddlFor(t));
  }
  prepared = [];
  const realPrepare = raw.prepare.bind(raw);
  raw.prepare = ((text: string) => {
    prepared.push(text);
    return realPrepare(text);
  }) as typeof raw.prepare;
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

function user(id: string, email: string, origin = "registration") {
  run("INSERT INTO users (id, email, origin, role) VALUES (?, ?, ?, 'USER')", id, email, origin);
}

function vendor(id: string, name: string, slug: string, userId: string | null, deleted = false) {
  run(
    `INSERT INTO vendors (id, user_id, business_name, slug, verified, commercial, can_self_confirm, deleted_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
    id,
    userId,
    name,
    slug,
    deleted ? 1_700_000_000 : null
  );
}

function event(id: string, name: string, startDate: number | null, status = "APPROVED") {
  run(
    "INSERT INTO events (id, name, slug, status, start_date) VALUES (?, ?, ?, ?, ?)",
    id,
    name,
    `slug-${id}`,
    status,
    startDate
  );
}

describe("query-string contract", () => {
  it("a bare call stays in the legacy every-row path", () => {
    expect(isPagedRequest(sp())).toBe(false);
    expect(isPagedRequest(sp("status=PENDING"))).toBe(false);
    expect(isPagedRequest(sp("page=2"))).toBe(true);
    expect(isPagedRequest(sp("format=csv"))).toBe(true);
  });

  it("caps page size and defaults a junk page number to 1", () => {
    expect(parseListParams(sp("pageSize=100000")).pageSize).toBe(100);
    expect(parseListParams(sp("page=-3")).page).toBe(1);
    expect(parseListParams(sp()).pageSize).toBe(50);
  });
});

describe("vendors", () => {
  async function list(query = "") {
    const params = sp(query);
    const parsed = parseListParams(params);
    return runList(vendorList(db, params, parsed).spec, parsed);
  }

  it("sends one page of rows and the true total", async () => {
    for (let i = 0; i < 120; i++)
      vendor(`v${i}`, `Vendor ${String(i).padStart(3, "0")}`, `v-${i}`, null);
    const first = await list("page=1");
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(120);
    expect(first.rows[0].businessName).toBe("Vendor 000");
    const third = await list("page=3");
    expect(third.rows).toHaveLength(20);
    expect(third.rows[0].businessName).toBe("Vendor 100");
  });

  it("finds an accented name from an ASCII search, as search_vendors does", async () => {
    vendor("v1", "Aéhkō Ceramics", "aehko-ceramics", null);
    vendor("v2", "Unrelated Soap", "unrelated-soap", null);
    const result = await list("page=1&q=aehko");
    expect(result.rows.map((r) => r.id)).toEqual(["v1"]);
    expect((await list("page=1&q=zzz")).rows).toEqual([]);
  });

  it("hides merge tombstones by default and shows them on request", async () => {
    vendor("live", "Live", "live", null);
    vendor("gone", "Gone", "gone", null, true);
    expect((await list("page=1")).rows.map((r) => r.id)).toEqual(["live"]);
    expect((await list("page=1&deleted=only")).rows.map((r) => r.id)).toEqual(["gone"]);
  });

  it("reports a placeholder or missing owner as unclaimed and never sends the address", async () => {
    user("real", "owner@example.com");
    user("ph", "pending+foo@meetmeatthefair.com", "ingestion");
    vendor("a", "A", "a", "real");
    vendor("b", "B", "b", "ph");
    vendor("c", "C", "c", null);
    const rows = (await list("page=1")).rows;
    expect(rows.map((r) => [r.id, r.unclaimed, r.ownerEmail])).toEqual([
      ["a", false, "owner@example.com"],
      ["b", true, null],
      ["c", true, null],
    ]);
    expect((await list("page=1&claim=unclaimed")).rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect((await list("page=1&claim=claimed")).rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("counts events per vendor and sorts by that count", async () => {
    vendor("few", "Few", "few", null);
    vendor("many", "Many", "many", null);
    run("INSERT INTO event_vendors (id, event_id, vendor_id) VALUES ('1','e1','many')");
    run("INSERT INTO event_vendors (id, event_id, vendor_id) VALUES ('2','e2','many')");
    run("INSERT INTO event_vendors (id, event_id, vendor_id) VALUES ('3','e3','few')");
    const rows = (await list("page=1&sort=events&dir=desc")).rows;
    expect(rows.map((r) => [r.id, r.eventCount])).toEqual([
      ["many", 2],
      ["few", 1],
    ]);
  });

  it("skips the users join for the count and the page of ids when nothing reads it", async () => {
    vendor("a", "A", "a", null);
    prepared.length = 0;
    await list("page=1");
    const narrow = prepared.filter((t) => !t.includes("event_vendors"));
    expect(narrow.length).toBe(2);
    for (const text of narrow) expect(text).not.toContain("left join");
    expect(narrow.join(" ")).not.toContain("IS NULL, ");

    prepared.length = 0;
    await list("page=1&claim=unclaimed");
    const joined = prepared.filter((t) => !t.includes("event_vendors"));
    for (const text of joined) expect(text).toContain("left join");
  });

  it("never exceeds D1's bound-parameter cap at the largest page size", async () => {
    for (let i = 0; i < 100; i++) vendor(`v${i}`, `Vendor ${i}`, `v-${i}`, null);
    prepared.length = 0;
    await list("page=1&pageSize=100");
    expect(prepared.length).toBeGreaterThan(0);
    for (const text of prepared) {
      expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    }
  });

  it("exports the whole filter to CSV, not one page", async () => {
    for (let i = 0; i < 60; i++) vendor(`v${i}`, `Vendor ${i}`, `v-${i}`, null);
    const params = sp("format=csv");
    const parsed = parseListParams(params);
    const list = vendorList(db, params, parsed);
    const rows = await runCsvRows(list.spec, parsed);
    expect(rows).toHaveLength(60);
    const csv = toCsv(list.csv, rows);
    expect(csv.split("\r\n")[0]).toContain("business_name");
    expect(csv.trim().split("\r\n")).toHaveLength(61);
  });
});

describe("events", () => {
  async function list(query = "") {
    const params = sp(query);
    const parsed = parseListParams(params);
    return runList(eventList(db, params, parsed).spec, parsed);
  }

  beforeEach(() => {
    event("nodate", "No Date", null, "TENTATIVE");
    event("early", "Early", 1_700_000_000);
    event("late", "Late", 1_800_000_000);
  });

  it("puts date-less rows last in both directions", async () => {
    expect((await list("page=1")).rows.map((r) => r.id)).toEqual(["early", "late", "nodate"]);
    expect((await list("page=1&sort=startDate&dir=desc")).rows.map((r) => r.id)).toEqual([
      "late",
      "early",
      "nodate",
    ]);
  });

  it("has a Needs date filter", async () => {
    expect((await list("page=1&date=needs-date")).rows.map((r) => r.id)).toEqual(["nodate"]);
  });

  it("applies the status and gate filters on the server", async () => {
    run(`UPDATE events SET gate_flags = '["x"]' WHERE id = 'early'`);
    run(`UPDATE events SET gate_flags = '[]' WHERE id = 'late'`);
    expect((await list("page=1&gate=flagged")).rows.map((r) => r.id)).toEqual(["early"]);
    expect((await list("page=1&status=TENTATIVE")).rows.map((r) => r.id)).toEqual(["nodate"]);
  });

  it("counts published blog posts per event only", async () => {
    run("INSERT INTO blog_posts (id, status) VALUES ('p1','PUBLISHED'), ('p2','DRAFT')");
    run(`INSERT INTO content_links (id, source_type, source_id, target_type, target_id)
         VALUES ('l1','BLOG_POST','p1','EVENT','early'), ('l2','BLOG_POST','p2','EVENT','early')`);
    const rows = (await list("page=1")).rows;
    expect(rows.find((r) => r.id === "early")?.blogPostCount).toBe(1);
    expect(rows.find((r) => r.id === "late")?.blogPostCount).toBe(0);
  });

  it("attaches a possible-duplicate candidate unless a human dismissed it", async () => {
    run("UPDATE events SET possible_duplicate_of = 'late' WHERE id = 'early'");
    let rows = (await list("page=1")).rows;
    expect(rows.find((r) => r.id === "early")?.possibleDuplicate?.id).toBe("late");
    run(
      "INSERT INTO event_duplicate_dismissals (id, event_id, candidate_id) VALUES ('d','early','late')"
    );
    rows = (await list("page=1")).rows;
    expect(rows.find((r) => r.id === "early")?.possibleDuplicate).toBeNull();
  });
});

describe("the other lists", () => {
  it("venues: counts events through a single-table select, and reports the missing tallies", async () => {
    run(
      "INSERT INTO venues (id, name, slug, city, state, status) VALUES ('a','A Hall','a-hall','Bath','ME','ACTIVE')"
    );
    run(
      "INSERT INTO venues (id, name, slug, city, state, status, latitude, google_place_id) VALUES ('b','B Hall','b-hall','Lee','NH','ACTIVE',1.0,'g')"
    );
    run(
      "INSERT INTO events (id, name, slug, status, venue_id) VALUES ('e1','E','e1','APPROVED','a')"
    );
    const params = sp("page=1");
    const parsed = parseListParams(params);
    const result = await runList(venueList(db, params, parsed).spec, parsed);
    expect(result.rows.map((r) => [r.id, r.eventCount])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
    expect(result.stats).toEqual({ missingCoords: 1, missingGoogle: 1 });
  });

  it("promoters: counts events and flags placeholders", async () => {
    user("ph", "pending+x@meetmeatthefair.com", "ingestion");
    run(
      "INSERT INTO promoters (id, user_id, company_name, slug, verified) VALUES ('p','ph','Acme','acme',0)"
    );
    run(
      "INSERT INTO events (id, name, slug, status, promoter_id) VALUES ('e1','E','e1','APPROVED','p')"
    );
    const params = sp("page=1");
    const parsed = parseListParams(params);
    const result = await runList(promoterList(db, params, parsed).spec, parsed);
    expect(result.rows[0]).toMatchObject({
      id: "p",
      unclaimed: true,
      ownerEmail: null,
      eventCount: 1,
    });
  });

  it("users: excludes placeholders by default", async () => {
    user("real", "real@example.com");
    user("ph", "pending+x@meetmeatthefair.com", "ingestion");
    const params = sp("page=1");
    const parsed = parseListParams(params);
    const result = await runList(userList(db, params, parsed).spec, parsed);
    expect(result.rows.map((r) => r.id)).toEqual(["real"]);
    const all = sp("page=1&includePlaceholders=1");
    expect(
      (await runList(userList(db, all, parseListParams(all)).spec, parseListParams(all))).total
    ).toBe(2);
  });

  it("performers: excludes deleted rows", async () => {
    run("INSERT INTO performers (id, name, slug, verified) VALUES ('a','Act','act',0)");
    run(
      "INSERT INTO performers (id, name, slug, verified, deleted_at) VALUES ('b','Gone','gone',0,1)"
    );
    const params = sp("page=1");
    const parsed = parseListParams(params);
    const result = await runList(performerList(db, params, parsed).spec, parsed);
    expect(result.rows.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("toCsv", () => {
  const cols = [{ header: "name", value: (r: { name: string }) => r.name }];

  it("quotes separators and neutralises spreadsheet formulas", () => {
    expect(toCsv(cols, [{ name: 'a,"b"' }])).toBe('name\r\n"a,""b"""\r\n');
    expect(toCsv(cols, [{ name: "=HYPERLINK(1)" }])).toBe("name\r\n'=HYPERLINK(1)\r\n");
  });
});
