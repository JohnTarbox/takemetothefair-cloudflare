/**
 * OPE-868 — the promoter website-health sweep.
 *
 * ## ⚠️ Amendment H, in the ticket's own words
 *
 * *"Point it at these two known-bad domains and watch it go red, then at a
 * known-good organizer URL and watch it stay green. A green run over a set with
 * no known-bad member proves nothing."*
 *
 * So the fixture estate deliberately contains BOTH: the two real repurposed
 * domains from OPE-857, and a real organizer page. A sweep that flagged
 * everything, or nothing, fails here.
 *
 * The other trap is `examined`. "0 actionable" is the same output for a healthy
 * estate and for a selector that silently stopped matching, which is the whole
 * reason OPE-860 exists. Every case asserts `examined` alongside the verdict
 * counts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY, company_name TEXT, slug TEXT, website TEXT,
    state TEXT, created_at INTEGER, updated_at INTEGER
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
let authorized = true;

vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => authorized }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

/** The Ledyard replacement: fair-shaped prose, no dates, no hours, no terms. */
const LEDYARD = `<html><head><title>Ledyard Fair</title></head><body>
<h1>The official information hub for the annual Ledyard Fair</h1>
<p>Welcome to the premier destination for everything about this beloved local
tradition. Our contributors bring you stories, history and community voices from
one of the region's best-loved gatherings, written by people who have been part
of it for many years and care deeply about keeping the memory alive.</p>
<div>23+ Years of Tradition · 3K+ Annual Fair Visitors</div></body></html>`;

/** The Clinton hijack: gambling SEO spam. */
const CLINTON = `<html><head><title>DRAGON222 Link Alternatif Situs Slot Gacor</title>
<meta name="keywords" content="Clinton, Lions, Fair, July 2019, admission"></head><body>
<h1>DRAGON222 Link Alternatif</h1><p>Situs slot gacor hari ini dengan link
alternatif terpercaya dan proses deposit cepat serta layanan pelanggan sepanjang
waktu untuk seluruh member setia kami di wilayah ini.</p></body></html>`;

/** A real organizer page: says when, what it costs, who may exhibit. */
const HEBRON = `<html><body><h1>Hebron Harvest Fair</h1>
<p>Join us September 4 through September 7, 2026 at the fairgrounds for four days
of agricultural exhibits, live music on the grandstand and the midway.</p>
<p>Admission is $12 at the gate. Hours are 8am to 10pm daily. Parking is free.</p>
<p>Vendors and exhibitors: applications for 2026 are open now.</p></body></html>`;

const PAGES: Record<string, { status: number; body: string } | "throw"> = {
  "https://ledyardfair.org": { status: 200, body: LEDYARD },
  "https://clintonlionsagfair207.com": { status: 200, body: CLINTON },
  "https://www.hebronharvestfair.org/": { status: 200, body: HEBRON },
  "https://gone.example.org": { status: 404, body: "not found" },
  "https://dns-fail.example.org": "throw",
};

beforeEach(() => {
  authorized = true;
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const u = typeof input === "string" ? input : input.url;
    const page = PAGES[u];
    if (!page || page === "throw") throw new Error("network");
    return new Response(page.body, { status: page.status });
  });
});

function seedPromoter(id: string, website: string | null) {
  raw
    .prepare(
      `INSERT INTO promoters (id, company_name, slug, website, created_at, updated_at)
       VALUES (?,?,?,?,0,0)`
    )
    .run(id, `Promoter ${id}`, id, website);
}

const { POST, GET } = await import("../sweep/route");

const sweep = (qs = "") =>
  POST(
    new Request(`http://localhost/api/admin/url-health/promoters/sweep${qs}`, { method: "POST" })
  );
const report = () => GET(new Request("http://localhost/api/admin/url-health/promoters/sweep"));

const rowsFor = (verdict: string) =>
  (
    raw.prepare(`SELECT COUNT(*) AS n FROM url_health_checks WHERE verdict = ?`).get(verdict) as {
      n: number;
    }
  ).n;

describe("OPE-868 — the estate contains known-bad AND known-good", () => {
  beforeEach(() => {
    seedPromoter("ledyard", "https://ledyardfair.org");
    seedPromoter("clinton", "https://clintonlionsagfair207.com");
    seedPromoter("hebron", "https://www.hebronharvestfair.org/");
  });

  it("flags exactly the two dead domains and clears the live one", async () => {
    const json = (await (await sweep()).json()) as Record<string, number>;

    // The landmark the ticket asks for by name.
    expect(json.examined).toBe(3);
    expect(json.no_event_signal).toBe(2);
    expect(json.ok).toBe(1);
    expect(json.actionable).toBe(2);
  });

  it("writes one durable row per URL, under the right source_field", async () => {
    await sweep();
    const rows = raw
      .prepare(`SELECT url, source_field, verdict FROM url_health_checks ORDER BY url`)
      .all() as Array<{ url: string; source_field: string; verdict: string }>;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.source_field))).toEqual(new Set(["promoters.website"]));
    expect(rows.find((r) => r.url.includes("hebron"))!.verdict).toBe("ok");
    expect(rows.find((r) => r.url.includes("ledyard"))!.verdict).toBe("no_event_signal");
  });

  it("records a healthy URL too — a failures-only table cannot answer 'last confirmed good'", async () => {
    await sweep();
    expect(rowsFor("ok")).toBe(1);
  });
});

describe("OPE-868 — the four outcomes stay distinct", () => {
  it("a 404 is http_error and a DNS failure is unreachable", async () => {
    seedPromoter("gone", "https://gone.example.org");
    seedPromoter("dns", "https://dns-fail.example.org");
    const json = (await (await sweep()).json()) as Record<string, number>;

    expect(json.examined).toBe(2);
    expect(json.http_error).toBe(1);
    expect(json.unreachable).toBe(1);
    // unreachable is deliberately NOT actionable on its own — origins blip, and
    // a queue full of transient DNS failures buries the real findings.
    expect(json.actionable).toBe(1);
  });
});

describe("OPE-868 — selection and paging", () => {
  it("skips promoters with no website, and says how many it examined", async () => {
    seedPromoter("none", null);
    seedPromoter("blank", "");
    seedPromoter("hebron", "https://www.hebronharvestfair.org/");
    const json = (await (await sweep()).json()) as Record<string, number>;
    expect(json.examined).toBe(1);
  });

  it("an EMPTY estate reports examined:0 — not a clean bill of health", async () => {
    // The distinction OPE-860 was filed about. Zero flagged is only meaningful
    // beside zero examined.
    const json = (await (await sweep()).json()) as Record<string, unknown>;
    expect(json.examined).toBe(0);
    expect(json.actionable).toBe(0);
    expect(json.next_cursor).toBeNull();
  });

  it("pages with a cursor and stops when the page is short", async () => {
    seedPromoter("a", "https://www.hebronharvestfair.org/");
    seedPromoter("b", "https://ledyardfair.org");
    const first = (await (await sweep("?chunk=1")).json()) as Record<string, number | null>;
    expect(first.examined).toBe(1);
    expect(first.next_cursor).toBe(1);

    const second = (await (await sweep("?cursor=1&chunk=1")).json()) as Record<
      string,
      number | null
    >;
    expect(second.examined).toBe(1);
    // A full page always advertises a next cursor; the following one comes back
    // empty. That is a deliberate extra round-trip rather than a guess about
    // whether the estate ended exactly on a boundary.
    const third = (await (await sweep("?cursor=2&chunk=1")).json()) as Record<string, unknown>;
    expect(third.examined).toBe(0);
  });

  it("refuses without the internal key", async () => {
    authorized = false;
    expect((await sweep()).status).toBe(401);
  });
});

describe("OPE-868 — the operator-readable report", () => {
  it("lists the actionable URLs and says how many were ever checked", async () => {
    seedPromoter("ledyard", "https://ledyardfair.org");
    seedPromoter("hebron", "https://www.hebronharvestfair.org/");
    await sweep();

    const json = (await (await report()).json()) as {
      urls_ever_checked: number;
      actionable_count: number;
      actionable: Array<{ url: string; verdict: string }>;
    };

    // Both halves. The count alone would be satisfied by an empty table.
    expect(json.urls_ever_checked).toBe(2);
    expect(json.actionable_count).toBe(1);
    expect(json.actionable[0].url).toContain("ledyardfair.org");
    expect(json.actionable[0].verdict).toBe("no_event_signal");
  });

  it("reports the LATEST verdict, so a recovered site drops off", async () => {
    seedPromoter("ledyard", "https://ledyardfair.org");
    await sweep();
    expect(((await (await report()).json()) as { actionable_count: number }).actionable_count).toBe(
      1
    );

    // The organizer takes the domain back and puts a real fair page on it.
    PAGES["https://ledyardfair.org"] = { status: 200, body: HEBRON };
    await sweep();
    const after = (await (await report()).json()) as {
      actionable_count: number;
      total_observations: number;
    };
    expect(after.actionable_count).toBe(0);
    // …and the history is kept: append-only is what tells a persistent failure
    // from a blip.
    expect(after.total_observations).toBe(2);
    PAGES["https://ledyardfair.org"] = { status: 200, body: LEDYARD };
  });
});
