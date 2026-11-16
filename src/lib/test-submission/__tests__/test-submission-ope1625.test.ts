/**
 * OPE-1625 — test submissions: the dry-run engine, the public "Check my
 * calendar" route, and `dry_run` on the promoter API. Run against the MCP
 * suite's full schema (plus the real 0411 DDL), with every outbound fetch
 * stubbed: no real organizer site is fetched.
 *
 * The no-write assertion counts every table the ticket names (and a few the
 * pipeline could plausibly touch) before and after each entry point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";
import { supportObligations } from "@/lib/db/schema";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
let sessionUser = "u-joyce";
let limiterMax: number | null = null;
const limiterHits = new Map<string, number>();
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({
    ok: true,
    userId: sessionUser,
    email: "someone@example.com",
  })),
}));
vi.mock("@/lib/burst-limiter", () => ({
  getBurstLimiter: () =>
    limiterMax === null
      ? null
      : {
          limit: async ({ key, max }: { key: string; max?: number }) => {
            const hits = (limiterHits.get(key) ?? 0) + 1;
            limiterHits.set(key, hits);
            return hits > (max ?? limiterMax!)
              ? { success: false, retryAfterSeconds: 1800 }
              : { success: true };
          },
        },
}));

import { DEFAULT_INCLUSION_RULES, parseTecPage } from "@takemetothefair/utils/feeds";
import { assessFeedItem, assessFormFields } from "../engine";
import { DryRunWriteError, assertReadOnly, readOnlyDb } from "../read-only-db";
import { CHECK_CALENDAR_RATE, PREVIEW_EVENT_RATE, checkCalendar } from "../check-calendar";
import { POST as checkPost } from "@/app/api/v1/check-calendar/route";
import { POST as previewPost } from "@/app/api/v1/preview-event/route";
import { signRequest } from "@/lib/promoter-api/auth";
import { PROMOTER_API_OPENAPI } from "@/lib/promoter-api/openapi";
import { POST as eventsPost } from "@/app/api/v1/promoter/events/route";
import { PATCH as eventPatch } from "@/app/api/v1/promoter/events/[externalId]/route";
import { POST as eventCancel } from "@/app/api/v1/promoter/events/[externalId]/cancel/route";
import { GET as keysGet, POST as keysPost } from "@/app/api/promoter/api-keys/route";
import { withPromoterApi } from "@/lib/promoter-api/handler";
import type { CalendarCheckReport, ItemReport } from "../types";

const ROOT = join(__dirname, "../../../..");
const MIGRATION_0411 = readFileSync(join(ROOT, "drizzle/0411_ope1620_promoter_api.sql"), "utf8");
const MIGRATION_0418 = readFileSync(join(ROOT, "drizzle/0418_ope1625_test_api_keys.sql"), "utf8");
const TEC = JSON.parse(readFileSync(join(__dirname, "fixtures/ohtm-like-tec.json"), "utf8"));
// The real OHTM export the OPE-1617 suite reads, read in place (not copied).
const OHTM_ICS = readFileSync(
  join(ROOT, "mcp-server/__tests__/fixtures/ohtm-ical-2026-11-10.ics"),
  "utf8"
);
const NOW = new Date("2026-11-10T16:00:00Z");
const BASE = "https://meetmeatthefair.com";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map(
    (c) =>
      `  ${c.name} ${c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT"}${c.primary ? " PRIMARY KEY" : ""}`
  );
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const n = (sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...p) as { n: number }).n;
const sec = (ymd: string) =>
  Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), 12) / 1000);
/** The better-sqlite3 test db, typed as the app's D1 handle (the routes get it the same way, via the mock). */
type AppDb = Parameters<typeof assessFeedItem>[0];
const appDb = () => db as unknown as AppDb;

/** Every table a test submission must not touch. */
const NO_WRITE_TABLES = [
  "events",
  "event_data_citations",
  "promoter_contacts",
  "pending_promoter_contacts",
  "support_obligations",
  "email_send_ledger",
  "promoter_import_rows",
  "promoter_api_event_refs",
  "promoter_event_feeds",
  // beyond the ticket's list: what the pipeline's side paths could write
  "promoter_feed_items",
  "event_review_flags",
  "event_days",
  "venues",
  "admin_actions",
  "error_logs",
];
const snapshot = () =>
  Object.fromEntries(NO_WRITE_TABLES.map((t) => [t, n(`SELECT count(*) n FROM ${t}`)]));

// ------------------------------------------------------------------ fetch stub

type Handler = (init: RequestInit | undefined) => Response;
let routes: Map<string, Handler>;
let dns: Map<string, string[]>;
let fetched: string[];

const tecResponse = (body: unknown = TEC) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function installFetch() {
  routes = new Map();
  dns = new Map();
  fetched = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const u = new URL(url);
      const host = u.searchParams.get("name")!;
      const type = u.searchParams.get("type");
      const ips = (dns.get(host) ?? []).filter((ip) => (type === "AAAA") === ip.includes(":"));
      return new Response(
        JSON.stringify({ Answer: ips.map((data) => ({ type: type === "AAAA" ? 28 : 1, data })) }),
        { headers: { "content-type": "application/dns-json" } }
      );
    }
    fetched.push(url);
    // Match ignoring the query (TEC adds per_page / start_date / end_date).
    const h = routes.get(url) ?? routes.get(url.split("?")[0]);
    if (!h) return new Response("not found", { status: 404 });
    return h(init);
  });
}

const checkReq = (body: unknown, ip = "203.0.113.7") =>
  checkPost(
    new Request(`${BASE}/api/v1/check-calendar`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

const previewReq = (body: unknown, ip = "203.0.113.7") =>
  previewPost(
    new Request(`${BASE}/api/v1/preview-event`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

// ------------------------------------------------------------------ fixtures

beforeEach(() => {
  ({ raw, db } = createTestDb());
  raw["exec"](MIGRATION_0411.slice(0, MIGRATION_0411.indexOf("INSERT INTO heartbeat_probes")));
  raw["exec"](MIGRATION_0418);
  raw["exec"](
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_days_event_date_vendor ON event_days(event_id, date, vendor_only)"
  );
  raw["exec"](`DROP TABLE IF EXISTS support_obligations;\n${ddlFor(supportObligations)}`);
  raw
    .prepare(
      "INSERT INTO users (id, email, role) VALUES ('u-joyce','joyce@example.com','PROMOTER'), ('u-other','other@example.com','PROMOTER')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, user_id, claimed) VALUES ('p-joyce','Joyce Shows','joyce','u-joyce',1), ('p-other','Other Org','other','u-other',1), ('p-museum','Example Transportation Museum','museum',NULL,0)"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url) VALUES ('e-theirs','Laconia Antiques Show','laconia','p-other',?,?,'APPROVED','https://other.example/laconia')"
    )
    .run(sec("2027-07-04"), sec("2027-07-04"));
  sessionUser = "u-joyce";
  limiterMax = null;
  limiterHits.clear();
  installFetch();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  raw.close();
});

/** A live listing with a private contact and an internal note, matched by the TEC fixture's 9104. */
function seedLiveListingWithPrivateData() {
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url, description) VALUES ('e-live','Antique Tractor Day','antique-tractor-day','p-museum',?,?,'APPROVED','https://museum.example/event/antique-tractor-day/','Old description')"
    )
    .run(sec("2027-05-15"), sec("2027-05-15"));
  raw
    .prepare(
      "INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at) VALUES ('e-live','INTERNAL-NOTE: owner disputes the date',1,1)"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO promoter_contacts (id, promoter_id, name, email, validation_method, status, created_at, updated_at) VALUES ('c-private','p-museum','Private Person','private.person@museum.example','domain_verified','validated',1,1)"
    )
    .run();
  // A second, NOT public listing the fixture's 9105 matches.
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url, description) VALUES ('e-pending','Truck Show (pending review)','truck-show-pending','p-museum',?,?,'PENDING','https://museum.example/event/truck-show/','PENDING-ONLY description')"
    )
    .run(sec("2027-07-10"), sec("2027-07-11"));
}

const byTitle = (items: ItemReport[], title: string) => {
  const i = items.find((x) => x.title === title);
  if (!i) throw new Error(`no item "${title}"`);
  return i;
};

// ------------------------------------------------------------------ the guard itself

describe("the read-only database handle", () => {
  it("refuses every write entry point and passes reads through", async () => {
    const blocked: string[] = [];
    const ro = readOnlyDb(appDb(), (op) => blocked.push(op));
    expect(() => ro.insert({} as never)).toThrow(DryRunWriteError);
    expect(() => ro.update({} as never)).toThrow(DryRunWriteError);
    expect(() => ro.delete({} as never)).toThrow(DryRunWriteError);
    expect(() => ro.run("select 1" as never)).toThrow(DryRunWriteError);
    expect(() => (ro as unknown as { $client: unknown }).$client).toThrow(DryRunWriteError);
    expect(blocked).toEqual(["insert", "update", "delete", "run", "$client"]);
    expect(raw.prepare("SELECT count(*) n FROM events").get()).toEqual({ n: 1 });
  });

  it("refuses the hidden write inside a real read path (autoLinkVenue's ambiguous-match audit row)", async () => {
    raw
      .prepare(
        "INSERT INTO venues (id, name, slug, city, state) VALUES ('v-a','Grange Hall','grange-a','Concord','NH'), ('v-b','Grange Hall','grange-b','Concord','NH')"
      )
      .run();
    const blocked: string[] = [];
    const before = snapshot();
    const r = await assessFormFields(
      readOnlyDb(appDb(), (op) => blocked.push(op)),
      {
        name: "Grange Supper",
        start_date: "2027-03-06",
        venue_name: "Grange Hall",
        city: "Concord",
        state: "NH",
      },
      { now: NOW, source: "from the form" }
    );
    expect(r.outcome.kind).toBe("new");
    // The audit insert, then logAuditWriteFailure's error_logs insert: both refused.
    expect(blocked).toContain("insert");
    expect(snapshot()).toEqual(before);
  });

  it("the engine refuses the real database", async () => {
    expect(() => assertReadOnly(db)).toThrow(/readOnlyDb/);
    await expect(
      assessFeedItem(appDb(), parseTecPage(TEC).events[0], {
        now: NOW,
        source: "from your calendar feed",
      })
    ).rejects.toThrow(/readOnlyDb/);
  });
});

// ------------------------------------------------------------------ engine

describe("the engine on an OHTM-like Events Calendar feed", () => {
  const assessAll = async () => {
    const ro = readOnlyDb(appDb());
    const out: ItemReport[] = [];
    for (const ev of parseTecPage(TEC).events)
      out.push(await assessFeedItem(ro, ev, { now: NOW, source: "from your calendar feed" }));
    return out;
  };

  it("picks up the events, skips closures, children's programs, past and out-of-region items, with reasons", async () => {
    const items = await assessAll();
    const verdict = Object.fromEntries(
      items.map((i) => [i.title, i.outcome.kind === "skip" ? i.outcome.reason : i.outcome.kind])
    );
    expect(verdict).toEqual({
      "Junior Inventors": "childrens_program",
      "Thanksgiving [Closed]": "closure",
      "Owls Nest: Turkey STEM": "childrens_program",
      "Antique Tractor Day": "new",
      "Truck Show": "new",
      "Hudson Valley Car Show": "outside_new_england",
      "Fall Auto Auction": "past_date",
    });
    // The reason names the OPE-1613 rule that decided it.
    expect(byTitle(items, "Thanksgiving [Closed]").outcome.summary).toMatch(/closure.*\\\[closed/i);
    expect(byTitle(items, "Junior Inventors").outcome.summary).toMatch(/children's.*junior/i);
    expect(DEFAULT_INCLUSION_RULES.excludeProgramPatterns).toContain("\\bjunior\\b");
  });

  it("a 04:30 start whose description says 4:30 PM is a problem (ingest.ts's am_pm_slip)", async () => {
    const items = await assessAll();
    const tractor = byTitle(items, "Antique Tractor Day");
    expect(tractor.problems).toContainEqual(
      expect.objectContaining({ code: "am_pm_slip", field: "daily_hours" })
    );
    expect(tractor.problems.find((p) => p.code === "am_pm_slip")!.message).toMatch(/4:30 AM.*PM/);
    // …and nothing else is flagged on a clean item.
    expect(byTitle(items, "Truck Show").problems.map((p) => p.code)).toEqual([]);
  });

  it("reports what it read, field by field, with the source", async () => {
    const tractor = byTitle(await assessAll(), "Antique Tractor Day");
    const read = Object.fromEntries(tractor.read.map((r) => [r.field, r]));
    expect(read.name).toMatchObject({
      value: "Antique Tractor Day",
      source: "from your calendar feed",
    });
    expect(read.start).toMatchObject({ value: "2027-05-15 4:30 AM" });
    expect(read.daily_hours).toMatchObject({ value: "4:30 AM – 8:00 AM" });
    expect(read.venue.value).toBe("Example Transportation Museum");
    expect(read.address.value).toBe("1 Museum Way, Owls Head, ME 04854");
    expect(read.admission.value).toBe("$10");
    expect(read.vendor_application_url).toMatchObject({ value: null, source: null });
  });

  it("past dates and incomplete locations are problems; form fields go through the import's row parser", async () => {
    const ro = readOnlyDb(appDb());
    const r = await assessFormFields(
      ro,
      {
        name: "Harvest Supper",
        start_date: "2026-10-01",
        daily_hours: "4:30-6:30",
        description: "Supper is served at 4:30 PM.",
        state: "NH",
      },
      { now: NOW, source: "from the form" }
    );
    expect(r.outcome).toMatchObject({ kind: "skip", reason: "invalid" });
    const codes = r.problems.map((p) => `${p.code}:${p.field}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "incomplete_location:city",
        "past_date:end_date",
        "am_pm_slip:daily_hours",
      ])
    );
    expect(r.read.find((x) => x.field === "name")!.source).toBe("from the form");
  });
});

// ------------------------------------------------------------------ public fields only

describe("a match shows only public fields", () => {
  it("names the live listing's public URL and its public diffs, and no contact, note or private column", async () => {
    seedLiveListingWithPrivateData();
    routes.set("https://museum.example/wp-json/tribe/events/v1/events", () => tecResponse());
    const report = await checkCalendar(
      readOnlyDb(appDb()),
      "https://museum.example/wp-json/tribe/events/v1/events",
      { now: NOW, deps: { resolveHost: async () => ["198.51.100.20"] } }
    );
    const tractor = byTitle(report.items, "Antique Tractor Day");
    expect(tractor.outcome).toMatchObject({
      kind: "match",
      listing: {
        url: "https://meetmeatthefair.com/events/antique-tractor-day",
        name: "Antique Tractor Day",
        public: true,
      },
    });
    const changes = tractor.outcome.kind === "match" ? tractor.outcome.changes : [];
    expect(changes).toContainEqual({
      field: "description",
      current: "Old description",
      proposed: "Tractors on the field from 4:30 PM until dusk.",
    });
    // The pending listing: a match, but nothing about it is shown.
    const truck = byTitle(report.items, "Truck Show");
    expect(truck.outcome).toMatchObject({
      kind: "match",
      listing: { url: null, name: null, public: false },
      changes: [],
    });
    const all = JSON.stringify(report);
    for (const secret of [
      "private.person",
      "Private Person",
      "INTERNAL-NOTE",
      "c-private",
      "e-live",
      "e-pending",
      "PENDING-ONLY",
      "truck-show-pending",
      "Truck Show (pending review)",
    ])
      expect(all).not.toContain(secret);
  });
});

// ------------------------------------------------------------------ the check-calendar route

describe("POST /api/v1/check-calendar", () => {
  it("reads an Events Calendar REST feed: picked up, skipped with reasons, problems — and writes nothing", async () => {
    seedLiveListingWithPrivateData();
    dns.set("museum.example", ["198.51.100.20"]);
    routes.set("https://museum.example/wp-json/tribe/events/v1/events", () => tecResponse());
    const before = snapshot();
    const res = await checkReq({ url: "https://museum.example/wp-json/tribe/events/v1/events" });
    expect(res.status).toBe(200);
    const report = (await res.json()) as CalendarCheckReport;
    expect(report).toMatchObject({
      dry_run: true,
      source: { kind: "tec_rest" },
      counts: { read: 7, would_pick_up: 2, skipped: 5 },
    });
    expect(fetched[0]).toMatch(/per_page=50&start_date=2026-10-11&end_date=2027-12-15/);
    expect(snapshot()).toEqual(before);
  });

  it("reads the real OHTM iCal export: kids' programs and closures skipped, the parade picked up — and writes nothing", async () => {
    dns.set("owlshead.example", ["198.51.100.21"]);
    routes.set(
      "https://owlshead.example/events/?ical=1",
      () => new Response(OHTM_ICS, { headers: { "content-type": "text/calendar" } })
    );
    const before = snapshot();
    const res = await checkReq({ url: "webcal://owlshead.example/events/?ical=1" });
    expect(res.status).toBe(200);
    const report = (await res.json()) as CalendarCheckReport;
    expect(report.source).toMatchObject({
      kind: "ical",
      calendar_name: "Owls Head Transportation Museum",
    });
    expect(report.counts.read).toBe(20);
    const kinds = (title: string) =>
      report.items
        .filter((i) => i.title === title)
        .map((i) => (i.outcome.kind === "skip" ? i.outcome.reason : i.outcome.kind));
    expect(kinds("Thanksgiving [Closed]")).toEqual(["closure"]);
    expect(kinds("Christmas Day [CLOSED]")).toEqual(["closure"]);
    expect(kinds("Junior Inventors - 3D Shapes")).toEqual(["childrens_program"]);
    expect(new Set(kinds("Owls Nest: Turkey STEM"))).toEqual(new Set(["childrens_program"]));
    expect(kinds("Rockland Parade of Lights")).toEqual(["new"]);
    expect(snapshot()).toEqual(before);
  });

  describe("SSRF", () => {
    it.each([
      "http://localhost/cal.ics",
      "http://127.0.0.1/cal.ics",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/cal.ics",
      "http://[::1]/cal.ics",
      "http://0.0.0.0/",
      "http://192.168.1.10/",
      "http://172.16.0.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://2130706433/",
      "ftp://museum.example/cal.ics",
      "file:///etc/passwd",
      "https://museum.example:8443/cal.ics",
    ])("refuses %s without fetching it", async (url) => {
      const res = await checkReq({ url });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toMatch(
        /blocked_url|invalid_url/
      );
      expect(fetched).toEqual([]);
    });

    it("refuses a redirect to a private host, and never requests it", async () => {
      dns.set("public.example", ["198.51.100.30"]);
      routes.set(
        "https://public.example/cal.ics",
        () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/cal.ics" } })
      );
      routes.set("http://10.0.0.5/cal.ics", () => new Response(OHTM_ICS));
      const res = await checkReq({ url: "https://public.example/cal.ics" });
      expect(res.status).toBe(422);
      expect(fetched).toEqual(["https://public.example/cal.ics"]);
    });

    it("refuses a redirect to a metadata host by name resolution, and a public name that resolves privately", async () => {
      dns.set("public.example", ["198.51.100.30"]);
      dns.set("rebind.example", ["10.1.2.3"]);
      routes.set(
        "https://public.example/cal.ics",
        () =>
          new Response(null, { status: 301, headers: { location: "https://rebind.example/x.ics" } })
      );
      expect((await checkReq({ url: "https://public.example/cal.ics" })).status).toBe(422);
      expect((await checkReq({ url: "https://rebind.example/x.ics" })).status).toBe(422);
      dns.set("v6.example", ["::1"]);
      expect((await checkReq({ url: "https://v6.example/x.ics" })).status).toBe(422);
      expect(fetched).toEqual(["https://public.example/cal.ics"]);
    });

    it("caps the size of what it reads", async () => {
      dns.set("big.example", ["198.51.100.31"]);
      routes.set(
        "https://big.example/cal.ics",
        () => new Response("x".repeat(2 * 1024 * 1024 + 10))
      );
      const res = await checkReq({ url: "https://big.example/cal.ics" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too_large");
    });
  });

  it(`rate-limits per IP: request ${CHECK_CALENDAR_RATE.max + 1} in the window is 429`, async () => {
    limiterMax = CHECK_CALENDAR_RATE.max;
    for (let i = 0; i < CHECK_CALENDAR_RATE.max; i++)
      expect((await checkReq("not json")).status).toBe(400);
    const limited = await checkReq("not json");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1800");
    // Another address is not limited by the first one's use.
    expect((await checkReq("not json", "198.51.100.99")).status).toBe(400);
    expect([...limiterHits.keys()]).toEqual([
      "check-calendar:203.0.113.7",
      "check-calendar:198.51.100.99",
    ]);
  });
});

// ------------------------------------------------------------------ the preview-event route (phase 2)

describe("POST /api/v1/preview-event", () => {
  const fair = {
    name: "Harvest Craft Fair",
    start_date: "2027-09-18",
    end_date: "2027-09-19",
    daily_hours: "10:00-16:00",
    venue_name: "Town Common",
    city: "Rockland",
    state: "ME",
    admission: "Free",
  };

  it("a new event: `new`, what we read with its source, and nothing written", async () => {
    const before = snapshot();
    const res = await previewReq({ fields: fair });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { dry_run, item } = (await res.json()) as { dry_run: boolean; item: ItemReport };
    expect(dry_run).toBe(true);
    expect(item.outcome.kind).toBe("new");
    expect(item.read.find((x) => x.field === "name")).toMatchObject({
      value: "Harvest Craft Fair",
      source: "from the form",
    });
    expect(snapshot()).toEqual(before);
  });

  it("flags the AM/PM slip and a missing city, and blank fields count as not filled in", async () => {
    const res = await previewReq({
      fields: {
        ...fair,
        city: "   ",
        daily_hours: "4:30-6:30",
        description: "Supper is served at 4:30 PM.",
      },
    });
    const { item } = (await res.json()) as { item: ItemReport };
    const codes = item.problems.map((p) => `${p.code}:${p.field}`);
    expect(codes).toEqual(
      expect.arrayContaining(["am_pm_slip:daily_hours", "incomplete_location:city"])
    );
  });

  it("a match shows only the public listing — no contact, note or private column", async () => {
    seedLiveListingWithPrivateData();
    const before = snapshot();
    const res = await previewReq({
      fields: {
        name: "Antique Tractor Day",
        start_date: "2027-05-15",
        venue_name: "Museum Field",
        city: "Owls Head",
        state: "ME",
        event_url: "https://museum.example/event/antique-tractor-day/",
      },
    });
    const body = await res.text();
    const { item } = JSON.parse(body) as { item: ItemReport };
    expect(item.outcome).toMatchObject({
      kind: "match",
      listing: { url: "https://meetmeatthefair.com/events/antique-tractor-day", public: true },
    });
    for (const secret of [
      "private.person",
      "Private Person",
      "INTERNAL-NOTE",
      "c-private",
      "e-live",
    ])
      expect(body).not.toContain(secret);
    expect(snapshot()).toEqual(before);
  });

  it("refuses unknown fields, over-long fields, bad JSON and an oversized body", async () => {
    expect((await previewReq({ fields: { ...fair, contact_email: "x@y.z" } })).status).toBe(422);
    expect((await previewReq({ fields: { name: "x".repeat(501) } })).status).toBe(422);
    expect((await previewReq({ name: "no fields wrapper" })).status).toBe(422);
    expect((await previewReq("not json")).status).toBe(400);
    expect((await previewReq("x".repeat(20_000))).status).toBe(413);
  });

  it(`rate-limits per IP on its own key: request ${PREVIEW_EVENT_RATE.max + 1} is 429`, async () => {
    limiterMax = PREVIEW_EVENT_RATE.max;
    for (let i = 0; i < PREVIEW_EVENT_RATE.max; i++)
      expect((await previewReq("not json")).status).toBe(400);
    const limited = await previewReq("not json");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1800");
    expect([...limiterHits.keys()]).toEqual(["preview-event:203.0.113.7"]);
    // check-calendar's allowance is untouched by preview use.
    expect((await checkReq("not json")).status).toBe(400);
  });
});

// ------------------------------------------------------------------ promoter API dry_run

let reqSeq = 0;
async function call(
  key: { key_id: string; secret: string },
  method: string,
  path: string,
  payload?: unknown,
  over: { requestId?: string } = {}
): Promise<Response> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = over.requestId ?? `req-${++reqSeq}`;
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-mmatf-key": key.key_id,
      "x-mmatf-timestamp": ts,
      "x-mmatf-request-id": requestId,
      "x-mmatf-signature": await signRequest(key.secret, ts, requestId, body),
    },
    body: method === "GET" ? undefined : body,
  });
  const m = /^\/api\/v1\/promoter\/events(?:\/([^/?]+))?(\/cancel)?/.exec(path)!;
  const params = Promise.resolve({ externalId: m[1] ?? "" });
  if (m[2]) return eventCancel(request, { params });
  if (m[1]) return eventPatch(request, { params });
  return eventsPost(request);
}

async function mintKey(opts: { test?: boolean } = {}) {
  const res = await keysPost(
    new Request(`${BASE}/api/promoter/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name: "Website sync", ...(opts.test ? { test: true } : {}) }),
    })
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { key_id: string; secret: string; test: boolean };
}

const FALL = {
  external_id: "fall-2027",
  name: "Fall Craft Fair",
  start_date: "2027-10-02",
  end_date: "2027-10-03",
  daily_hours: "9am-4pm",
  venue_name: "Grange Hall",
  city: "Concord",
  state: "NH",
  booth_fee_min: 60,
  admission: "Free",
};

interface DryBody {
  dry_run: true;
  external_id: string;
  would_return: {
    status: number;
    outcome?: string;
    event_id?: string | null;
    error?: { code: string };
  };
  report: ItemReport;
}

describe("promoter API dry_run", () => {
  it("a new external_id: reports `new` with what we read, and writes no ref, ledger row or event; the request id is used", async () => {
    const key = await mintKey();
    const before = snapshot();
    const res = await call(key, "POST", "/api/v1/promoter/events?dry_run=true", FALL, {
      requestId: "dry-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryBody;
    expect(body).toMatchObject({
      dry_run: true,
      external_id: "fall-2027",
      would_return: { status: 201, outcome: "created", event_id: null },
      report: { outcome: { kind: "new" }, problems: [] },
    });
    expect(body.report.read.find((r) => r.field === "name")).toMatchObject({
      value: "Fall Craft Fair",
      source: "from your API request",
    });
    expect(snapshot()).toEqual(before);
    // Replay protection stays honest: the dry run consumed its request id.
    const replay = await call(key, "POST", "/api/v1/promoter/events", FALL, { requestId: "dry-1" });
    expect(replay.status).toBe(409);
    // The REAL (refused) replay logs its 409, as every refused real call does.
    expect(snapshot()).toEqual({ ...before, error_logs: before.error_logs + 1 });
  });

  it('"dry_run": true in the body works too; a non-boolean is a 422', async () => {
    const key = await mintKey();
    const before = snapshot();
    const res = await call(key, "POST", "/api/v1/promoter/events", { ...FALL, dry_run: true });
    expect(((await res.json()) as DryBody).dry_run).toBe(true);
    const bad = await call(key, "POST", "/api/v1/promoter/events", { ...FALL, dry_run: "yes" });
    expect(bad.status).toBe(422);
    expect(snapshot()).toEqual({ ...before, error_logs: before.error_logs + 1 });
  });

  it("an existing ref is a `match` with the diffs; POST, PATCH and cancel dry runs write nothing", async () => {
    const key = await mintKey();
    const created = await call(key, "POST", "/api/v1/promoter/events", FALL);
    expect(created.status).toBe(201);
    const eventId = ((await created.json()) as { event_id: string }).event_id;
    const before = snapshot();
    const ledger = n("SELECT count(*) n FROM promoter_import_rows");

    const up = (await (
      await call(key, "POST", "/api/v1/promoter/events?dry_run=1", { ...FALL, booth_fee_min: 75 })
    ).json()) as DryBody;
    expect(up.would_return).toMatchObject({
      status: 200,
      outcome: "update_staged",
      event_id: eventId,
    });
    expect(up.report.outcome).toEqual({
      kind: "match",
      summary: expect.any(String),
      // Their own PENDING listing: named, not yet public.
      listing: { url: null, name: "Fall Craft Fair", public: false },
      changes: [{ field: "booth_fee_min", current: "60.00", proposed: "75.00" }],
    });

    raw.prepare("UPDATE events SET status='APPROVED' WHERE id=?").run(eventId);
    const slug = (
      raw.prepare("SELECT slug FROM events WHERE id=?").get(eventId) as { slug: string }
    ).slug;
    const patched = (await (
      await call(key, "PATCH", "/api/v1/promoter/events/fall-2027?dry_run=true", {
        description: "Sixty artisans.",
      })
    ).json()) as DryBody;
    expect(patched.report.outcome).toMatchObject({
      kind: "match",
      listing: { url: `${BASE}/events/${slug}`, public: true },
      changes: [{ field: "description", current: null, proposed: "Sixty artisans." }],
    });
    // A patch's absent fields are not "missing".
    expect(patched.report.problems).toEqual([]);

    const cancel = (await (
      await call(key, "POST", "/api/v1/promoter/events/fall-2027/cancel?dry_run=true", {
        reason: "Hall flooded",
      })
    ).json()) as DryBody;
    expect(cancel.would_return).toMatchObject({ status: 200, outcome: "cancel_staged" });
    expect(cancel.report.outcome).toMatchObject({
      kind: "match",
      changes: [
        { field: "status", current: "APPROVED", proposed: "CANCELLED" },
        { field: "reason", current: null, proposed: "Hall flooded" },
      ],
    });

    expect(snapshot()).toEqual(before);
    expect(n("SELECT count(*) n FROM promoter_import_rows")).toBe(ledger);
    expect(n("SELECT count(*) n FROM events WHERE id=? AND status='APPROVED'", eventId)).toBe(1);
    expect(n("SELECT vendor_fee_min_cents n FROM events WHERE id=?", eventId)).toBe(6000);
  });

  it("another organizer's event: the 409 the real call would get, as a skip — nothing written", async () => {
    const key = await mintKey();
    const before = snapshot();
    const body = (await (
      await call(key, "POST", "/api/v1/promoter/events?dry_run=true", {
        external_id: "laconia",
        name: "Laconia Antiques Show",
        start_date: "2027-07-04",
        city: "Laconia",
        state: "NH",
        event_url: "https://other.example/laconia",
      })
    ).json()) as DryBody;
    expect(body.would_return).toMatchObject({
      status: 409,
      error: { code: "conflict_other_promoter" },
    });
    expect(body.report.outcome).toMatchObject({
      kind: "skip",
      reason: "listed_by_another_organizer",
    });
    expect(snapshot()).toEqual(before);
  });

  it("flags the AM/PM slip in an API body", async () => {
    const key = await mintKey();
    const body = (await (
      await call(key, "POST", "/api/v1/promoter/events?dry_run=true", {
        ...FALL,
        daily_hours: "4:30-6:30",
        description: "Doors open at 4:30 PM.",
      })
    ).json()) as DryBody;
    expect(body.report.problems).toContainEqual(
      expect.objectContaining({ code: "am_pm_slip", severity: "warning" })
    );
  });

  it("the OpenAPI document declares dry_run on all three write routes", () => {
    const paths = PROMOTER_API_OPENAPI.paths as unknown as Record<
      string,
      Record<string, { parameters?: Array<{ name: string }> }>
    >;
    for (const [p, m] of [
      ["/api/v1/promoter/events", "post"],
      ["/api/v1/promoter/events/{external_id}", "patch"],
      ["/api/v1/promoter/events/{external_id}/cancel", "post"],
    ] as const)
      expect(paths[p][m].parameters?.map((x) => x.name)).toContain("dry_run");
    expect(Object.keys(PROMOTER_API_OPENAPI.components.schemas)).toEqual(
      expect.arrayContaining(["DryRunResult", "TestReport"])
    );
  });
});

// ------------------------------------------------------------------ promoter API test keys

describe("promoter API test keys (can never publish)", () => {
  it("a key minted with test:true says so at creation and in the list; a normal key does not", async () => {
    const live = await mintKey();
    const test = await mintKey({ test: true });
    expect(live.test).toBe(false);
    expect(test.test).toBe(true);
    const listed = (await (await keysGet()).json()) as {
      keys: Array<{ key_id: string; test: boolean }>;
    };
    expect(listed.keys.find((k) => k.key_id === test.key_id)?.test).toBe(true);
    expect(listed.keys.find((k) => k.key_id === live.key_id)?.test).toBe(false);
  });

  it("a plain write with a test key answers the dry-run report and writes nothing — even with dry_run:false", async () => {
    const key = await mintKey({ test: true });
    const before = snapshot();
    const res = await call(key, "POST", "/api/v1/promoter/events", { ...FALL, dry_run: false });
    expect(res.status).toBe(200);
    expect((await res.json()) as DryBody & { test_key: boolean }).toMatchObject({
      dry_run: true,
      test_key: true,
      would_return: { status: 201, outcome: "created", event_id: null },
      report: { outcome: { kind: "new" } },
    });
    expect(snapshot()).toEqual(before);
  });

  it("PATCH and cancel with a test key are dry runs on the promoter's real listing", async () => {
    const live = await mintKey();
    const created = await call(live, "POST", "/api/v1/promoter/events", FALL);
    expect(created.status).toBe(201);
    const test = await mintKey({ test: true });
    const before = snapshot();
    const patch = await call(test, "PATCH", "/api/v1/promoter/events/fall-2027", {
      booth_fee_min: 75,
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()) as DryBody).toMatchObject({
      dry_run: true,
      would_return: { status: 200, outcome: "update_staged" },
    });
    const cancel = await call(test, "POST", "/api/v1/promoter/events/fall-2027/cancel", {});
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as DryBody).dry_run).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("structural layer: a test key's route is handed a database that refuses writes", async () => {
    const key = await mintKey({ test: true });
    const body = "{}";
    const ts = String(Math.floor(Date.now() / 1000));
    const request = new Request(`${BASE}/api/v1/promoter/events`, {
      method: "POST",
      headers: {
        "x-mmatf-key": key.key_id,
        "x-mmatf-timestamp": ts,
        "x-mmatf-request-id": "structural-1",
        "x-mmatf-signature": await signRequest(key.secret, ts, "structural-1", body),
      },
      body,
    });
    let threw: unknown = null;
    // A route that FORGETS to honour testKey and writes anyway.
    const res = await withPromoterApi(request, "/test/forgetful", async ({ db: routeDb }) => {
      try {
        await routeDb.insert(supportObligations).values({} as never);
      } catch (e) {
        threw = e;
      }
      return new Response(null, { status: 204 });
    });
    expect(res.status).toBe(204);
    expect(threw).toBeInstanceOf(DryRunWriteError);
  });
});
