/**
 * OPE-988 — the source-agreement / domain-takeover sweep, end to end over a
 * real SQLite and the real fetched pages (goodwill/__tests__/fixtures/ope988).
 *
 * The estate deliberately holds known-bad AND known-good (amendment H): the
 * Fort Wayne page behind a Leominster event (RED, disagreement), the Rotary
 * events page behind the same event's twin (GREEN), a hijacked domain (RED,
 * takeover), a real organizer homepage (GREEN), and an aggregator the sweep
 * must not fetch at all. A sweep that flagged everything, or nothing, fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const F = (f: string) =>
  readFileSync(
    join(__dirname, "../../../../../../lib/goodwill/__tests__/fixtures/ope988", f),
    "utf8"
  );

const SCHEMA_SQL = `
  CREATE TABLE promoters (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, website TEXT);
  CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, promoter_id TEXT,
    venue_id TEXT, state_code TEXT, start_date INTEGER, status TEXT, merged_into TEXT,
    source_url TEXT
  );
  CREATE TABLE url_health_checks (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, source_field TEXT NOT NULL,
    verdict TEXT NOT NULL, http_status INTEGER, signals TEXT, detail TEXT,
    checked_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const logError = vi.fn(async (_: unknown) => {});
const fetched: string[] = [];
vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => true }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: (_db: unknown, a: unknown) => logError(a) }));

const FORT_WAYNE = "https://www.johnnyappleseedfest.com/";
const ROTARY = "https://www.leominsterrotary.org/Events?Year=2026&Month=9&Day=19";
const HIJACKED = "https://leominster-rotary.org/";
const FRYEBURG = "https://www.fryeburgfair.org/";
const AGGREGATOR = "https://www.mainemade.com/event/something/";

const PAGES: Record<string, string> = {
  [FORT_WAYNE]: F("johnnyappleseedfest_com.html"),
  [ROTARY]: F("leominsterrotary_org_events.html"),
  [HIJACKED]: F("leominster-rotary_org.html"),
  [FRYEBURG]: F("fryeburgfair_org.html"),
};

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function seed() {
  raw.prepare(`INSERT INTO promoters VALUES ('p1','Rotary Club of Leominster',NULL)`).run();
  raw.prepare(`INSERT INTO promoters VALUES ('p2','Fryeburg Fair',NULL)`).run();
  raw
    .prepare(
      `INSERT INTO venues VALUES ('v1','Downtown Leominster (Monument Square)','Leominster','MA')`
    )
    .run();
  raw.prepare(`INSERT INTO venues VALUES ('v2','Fryeburg Fairgrounds','Fryeburg','ME')`).run();
  const ev = raw.prepare(
    `INSERT INTO events (id,name,slug,promoter_id,venue_id,start_date,status,merged_into,source_url)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  ev.run(
    "e-wrong",
    "Johnny Appleseed Arts and Cultural Festival",
    "jaf-wrong",
    "p1",
    "v1",
    now() + 6 * DAY,
    "APPROVED",
    null,
    FORT_WAYNE
  );
  ev.run(
    "e-right",
    "Johnny Appleseed Arts and Cultural Festival",
    "jaf-right",
    "p1",
    "v1",
    now() + 6 * DAY,
    "APPROVED",
    null,
    ROTARY
  );
  ev.run(
    "e-hijack",
    "Rotary Pancake Breakfast",
    "pancakes",
    "p1",
    "v1",
    now() - 5 * DAY,
    "APPROVED",
    null,
    HIJACKED
  );
  ev.run(
    "e-fryeburg",
    "Fryeburg Fair 2026",
    "fryeburg-fair-2026",
    "p2",
    "v2",
    now() + 20 * DAY,
    "APPROVED",
    null,
    FRYEBURG
  );
  ev.run(
    "e-agg",
    "Maine Thing",
    "maine-thing",
    "p2",
    "v2",
    now() + 10 * DAY,
    "APPROVED",
    null,
    AGGREGATOR
  );
  // Out of scope: outside the window, merged tombstone, rejected.
  ev.run("e-old", "Old", "old", "p2", "v2", now() - 90 * DAY, "APPROVED", null, FORT_WAYNE);
  ev.run(
    "e-merged",
    "Merged",
    "merged",
    "p2",
    "v2",
    now() + DAY,
    "APPROVED",
    "e-right",
    FORT_WAYNE
  );
  ev.run(
    "e-rejected",
    "Rejected",
    "rejected",
    "p2",
    "v2",
    now() + DAY,
    "REJECTED",
    null,
    FORT_WAYNE
  );
}

beforeEach(() => {
  logError.mockClear();
  fetched.length = 0;
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const u = typeof input === "string" ? input : input.url;
    fetched.push(u);
    const body = PAGES[u];
    if (body === undefined) throw new Error("network");
    return new Response(body, { status: 200 });
  });
});

const { POST } = await import("../sweep/route");
const sweep = async (qs = "") =>
  (await (
    await POST(
      new Request(`http://localhost/api/admin/url-health/source-agreement/sweep${qs}`, {
        method: "POST",
      })
    )
  ).json()) as Record<string, unknown> & {
    verdicts: Record<string, number>;
    agreement: { agrees: number; disagrees: number; unjudged: number };
    disagreements: Array<{ eventId: string; otherStates: string[]; sourceUrl: string }>;
    takeovers: Array<{ url: string; signals: string[] }>;
  };

describe("OPE-988 ACCEPTANCE — known-bad and known-good in one estate", () => {
  beforeEach(seed);

  it("reports the denominator, skips the aggregator unfetched, and flags exactly the two bad URLs", async () => {
    const json = await sweep();

    expect(json.events_in_window).toBe(5);
    expect(json.skipped_non_organizer_events).toBe(1);
    expect(json.organizer_urls_total).toBe(4);
    expect(json.examined).toBe(4);
    expect(fetched).not.toContain(AGGREGATOR);

    // Agreement: Fort Wayne disagrees, Rotary and Fryeburg agree.
    expect(json.agreement).toEqual({ agrees: 2, disagrees: 1, unjudged: 0 });
    expect(json.disagreements).toEqual([
      expect.objectContaining({ eventId: "e-wrong", sourceUrl: FORT_WAYNE, otherStates: ["IN"] }),
    ]);

    // Takeover: only the hijacked domain.
    expect(json.domain_takeover).toBe(1);
    expect(json.takeovers.map((t) => t.url)).toEqual([HIJACKED]);
    expect(json.actionable).toBeGreaterThanOrEqual(1);
    expect(json.next_cursor).toBeNull();
  });

  it("writes one url_health_checks row per URL under its OWN source_field, for every verdict", async () => {
    await sweep();
    const rows = raw
      .prepare(`SELECT url, source_field, verdict, signals FROM url_health_checks ORDER BY url`)
      .all() as Array<{ url: string; source_field: string; verdict: string; signals: string }>;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.source_field))).toEqual(
      new Set(["events.source_url@source-agreement"])
    );
    expect(rows.find((r) => r.url === HIJACKED)!.verdict).toBe("domain_takeover");
    expect(rows.find((r) => r.url === FORT_WAYNE)!.signals).toContain("agreement:disagrees(1/1)");
    expect(rows.find((r) => r.url === ROTARY)!.signals).toContain("agreement:agrees");
    expect(rows.find((r) => r.url === FRYEBURG)!.verdict).not.toBe("domain_takeover");
  });

  it("warns on the takeover, naming the events that cite it", async () => {
    await sweep();
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "url-health:domain-takeover",
        context: expect.objectContaining({ url: HIJACKED, events: ["pancakes"] }),
      })
    );
  });

  it("never touches the event rows", async () => {
    const before = raw.prepare(`SELECT id, source_url FROM events ORDER BY id`).all();
    await sweep();
    expect(raw.prepare(`SELECT id, source_url FROM events ORDER BY id`).all()).toEqual(before);
  });

  it("pages with a cursor over DISTINCT organizer URLs", async () => {
    const first = await sweep("?chunk=3");
    expect(first.examined).toBe(3);
    expect(first.next_cursor).toBe(3);
    const second = await sweep("?cursor=3&chunk=3");
    expect(second.examined).toBe(1);
    expect(second.next_cursor).toBeNull();
  });
});

describe("OPE-988 — an empty estate is not a clean bill of health", () => {
  it("says examined:0 and events_in_window:0", async () => {
    const json = await sweep();
    expect(json.examined).toBe(0);
    expect(json.events_in_window).toBe(0);
    expect(json.disagreements).toEqual([]);
  });
});
