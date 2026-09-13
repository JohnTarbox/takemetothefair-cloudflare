/**
 * OPE-979 — the promoter sweep reads a closure notice served as a 503, runs the
 * same-page-on-every-path check against a stored event URL on the host, and
 * alerts. Real pages (goodwill/__tests__/fixtures/ope979), fetched 2026-09-13.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const F = (f: string) =>
  readFileSync(
    join(__dirname, "../../../../../../lib/goodwill/__tests__/fixtures/ope979", f),
    "utf8"
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const logError = vi.fn(async (_: unknown) => {});
vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => true }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
// logError(db, entry) — forward the ENTRY. Recording the drizzle db as the call arg
// makes a failed toHaveBeenCalledWith pretty-print it, which exhausts the heap.
vi.mock("@/lib/logger", () => ({ logError: (_db: unknown, a: unknown) => logError(a) }));

const PAGES: Record<string, { status: number; body: string }> = {
  "https://eagleshows.com/": { status: 503, body: F("eagleshows_com.html") },
  "https://eagleshows.com/event/marlborough-gun-show-9-19-26/": {
    status: 503,
    body: F("eagleshows_com_event_marlborough-gun-show-9-19-26.html"),
  },
  "https://easterngunexpo.com/": { status: 200, body: F("easterngunexpo_com.html") },
};

beforeEach(() => {
  logError.mockClear();
  raw = new Database(":memory:");
  raw["exec"](`
    CREATE TABLE promoters (id TEXT PRIMARY KEY, company_name TEXT, slug TEXT, website TEXT, state TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE url_health_checks (id TEXT PRIMARY KEY, url TEXT NOT NULL, source_field TEXT NOT NULL, verdict TEXT NOT NULL, http_status INTEGER, signals TEXT, detail TEXT, checked_at INTEGER NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, source_url TEXT);
  `);
  db = drizzle(raw, { schema });
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const u = typeof input === "string" ? input : input.url;
    const p = PAGES[u];
    if (!p) throw new Error(`unexpected fetch ${u}`);
    return new Response(p.body, { status: p.status });
  });
  raw
    .prepare(
      `INSERT INTO promoters (id, company_name, slug, website, created_at, updated_at) VALUES ('9703b5c0','Eagle Shows','eagle-shows','https://eagleshows.com/',0,0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO promoters (id, company_name, slug, website, created_at, updated_at) VALUES ('a47e02d4','Eastern Gun Expo','eastern-gun-expo','https://easterngunexpo.com/',0,0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO events (id, source_url) VALUES ('7e294fa4', 'https://eagleshows.com/event/marlborough-gun-show-9-19-26/')`
    )
    .run();
});

const { POST, GET } = await import("../sweep/route");

describe("OPE-979 — sweep", () => {
  it("ACCEPTANCE: Eagle Shows is a closure_notice (red), Eastern Gun Expo stays ok (green)", async () => {
    const json = (await (
      await POST(new Request("http://localhost/x", { method: "POST" }))
    ).json()) as Record<string, number>;
    expect(json.examined).toBe(2); // landmark
    expect(json).toMatchObject({
      closure_notice: 1,
      ok: 1,
      http_error: 0,
      same_page_on_every_path: 1,
      actionable: 1,
    });

    const row = raw
      .prepare(
        `SELECT verdict, http_status, signals FROM url_health_checks WHERE url = 'https://eagleshows.com/'`
      )
      .get() as {
      verdict: string;
      http_status: number;
      signals: string;
    };
    expect(row).toMatchObject({ verdict: "closure_notice", http_status: 503 });
    expect(row.signals.split(",")).toEqual(
      expect.arrayContaining(["closure-phrase", "same-page-on-every-path"])
    );
  });

  it("alerts on the closure, and the report lists it as actionable", async () => {
    await POST(new Request("http://localhost/x", { method: "POST" }));
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "url-health:closure-notice" })
    );
    const rep = (await (await GET(new Request("http://localhost/x"))).json()) as {
      actionable: Array<{ url: string; verdict: string }>;
    };
    expect(rep.actionable).toEqual([
      expect.objectContaining({ url: "https://eagleshows.com/", verdict: "closure_notice" }),
    ]);
  });
});
