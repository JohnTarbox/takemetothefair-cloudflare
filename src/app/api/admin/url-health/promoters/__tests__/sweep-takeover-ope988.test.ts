/**
 * OPE-988 — the promoter website sweep records a hijacked domain as
 * `domain_takeover`, warns, and lists it in the report. Real pages
 * (goodwill/__tests__/fixtures/ope988), fetched 2026-09-13.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const logError = vi.fn(async (_: unknown) => {});
vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => true }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: (_db: unknown, a: unknown) => logError(a) }));

const PAGES: Record<string, string> = {
  "https://leominster-rotary.org": F("leominster-rotary_org.html"),
  "https://www.fryeburgfair.org/": F("fryeburgfair_org.html"),
};

beforeEach(() => {
  logError.mockClear();
  raw = new Database(":memory:");
  raw["exec"](`
    CREATE TABLE promoters (id TEXT PRIMARY KEY, company_name TEXT, slug TEXT, website TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, source_url TEXT);
    CREATE TABLE url_health_checks (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, source_field TEXT NOT NULL,
      verdict TEXT NOT NULL, http_status INTEGER, signals TEXT, detail TEXT,
      checked_at INTEGER NOT NULL
    );
  `);
  raw
    .prepare(
      `INSERT INTO promoters VALUES ('p1','Rotary Club of Leominster','r','https://leominster-rotary.org')`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO promoters VALUES ('p2','Fryeburg Fair','f','https://www.fryeburgfair.org/')`
    )
    .run();
  db = drizzle(raw, { schema });
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const u = typeof input === "string" ? input : input.url;
    const body = PAGES[u];
    if (body === undefined) throw new Error("network");
    return new Response(body, { status: 200 });
  });
});

const { POST, GET } = await import("../sweep/route");

describe("OPE-988 — promoter sweep", () => {
  it("RED leominster-rotary.org → domain_takeover; GREEN Fryeburg Fair is not", async () => {
    const json = (await (
      await POST(
        new Request("http://localhost/api/admin/url-health/promoters/sweep", { method: "POST" })
      )
    ).json()) as Record<string, number>;
    expect(json.examined).toBe(2);
    expect(json.domain_takeover).toBe(1);
    expect(json.actionable).toBe(1);

    const rows = raw
      .prepare(`SELECT url, verdict, signals FROM url_health_checks ORDER BY url`)
      .all() as Array<{ url: string; verdict: string; signals: string }>;
    expect(rows.find((r) => r.url.includes("leominster"))!.verdict).toBe("domain_takeover");
    expect(rows.find((r) => r.url.includes("leominster"))!.signals).toContain(
      "spam-title:gambling"
    );
    expect(rows.find((r) => r.url.includes("fryeburg"))!.verdict).toBe("ok");

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "url-health:domain-takeover" })
    );

    const report = (await (
      await GET(new Request("http://localhost/api/admin/url-health/promoters/sweep"))
    ).json()) as { actionable: Array<{ url: string; verdict: string }> };
    expect(report.actionable).toEqual([
      expect.objectContaining({ url: "https://leominster-rotary.org", verdict: "domain_takeover" }),
    ]);
  });
});
