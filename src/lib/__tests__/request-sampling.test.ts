/**
 * A9 (2026-06-26) — request sampling gate + writer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_RSC_ANON_KIND,
  isAnonymousAdminRscRequest,
  shouldSample,
  truncateIp,
  writeRequestSample,
  REQUEST_SAMPLE_RATE,
} from "../request-sampling";

describe("shouldSample", () => {
  it("captures below the rate, skips at/above it", () => {
    expect(shouldSample(0)).toBe(true);
    expect(shouldSample(REQUEST_SAMPLE_RATE - 0.0001)).toBe(true);
    expect(shouldSample(REQUEST_SAMPLE_RATE)).toBe(false);
    expect(shouldSample(0.99)).toBe(false);
  });
});

// OPE-1397 — built from the real migrations (0130 creates the table, 0373 adds
// `kind`) rather than hand-written DDL, so the test cannot drift from prod.
const DRIZZLE = join(__dirname, "..", "..", "..", "drizzle");
const SCHEMA_SQL = ["0130_request_samples.sql", "0373_ope1397_request_samples_kind.sql"]
  .map((f) => readFileSync(join(DRIZZLE, f), "utf8"))
  .join("\n");

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

function rowCount(): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM request_samples`).get() as { n: number }).n;
}

describe("writeRequestSample", () => {
  it("inserts a sampled row with UA/IP/ASN/path", async () => {
    await writeRequestSample(db as never, {
      path: "/events/cheshire-fair",
      method: "GET",
      userAgent: "BotCrawler/1.0",
      ip: "203.0.113.7",
      asn: 14618,
      asOrganization: "AMAZON-AES",
      country: "US",
      referer: null,
      ray: "abc-IAD",
    });
    const r = raw.prepare(`SELECT * FROM request_samples`).get() as Record<string, unknown>;
    expect(rowCount()).toBe(1);
    expect(r.user_agent).toBe("BotCrawler/1.0");
    expect(r.asn).toBe(14618);
    expect(r.as_organization).toBe("AMAZON-AES");
    expect(r.path).toBe("/events/cheshire-fair");
    // OPE-971 — the network prefix is stored, never the address.
    expect(r.ip).toBe("203.0.113.0/24");
  });

  it("OPE-971 — the write NEVER prunes, however old the table's rows are", async () => {
    const now = new Date("2026-06-26T00:00:00Z");
    raw
      .prepare(`INSERT INTO request_samples (id, timestamp) VALUES ('old', ?)`)
      .run(Math.floor(new Date("2026-03-28T00:00:00Z").getTime() / 1000));
    for (let i = 0; i < 300; i++) {
      await writeRequestSample(db as never, { path: `/x/${i}` }, { now });
    }
    // Under the old 1% roll, 300 writes all but guaranteed a prune. Retention is
    // the MCP cron's job now (mcp-server/src/request-sample-retention.ts).
    const ids = (raw.prepare(`SELECT id FROM request_samples`).all() as { id: string }[]).map(
      (r) => r.id
    );
    expect(ids).toContain("old");
    expect(rowCount()).toBe(301);
  });

  it("never throws (best-effort) — a bad db is swallowed", async () => {
    const brokenDb = {
      insert: () => {
        throw new Error("d1 down");
      },
    };
    await expect(writeRequestSample(brokenDb as never, { path: "/x" })).resolves.toBeUndefined();
  });
});

describe("OPE-1397 — kind", () => {
  it("an A9 sample defaults to kind='page'", async () => {
    await writeRequestSample(db as never, { path: "/events/x" });
    const r = raw.prepare(`SELECT kind FROM request_samples`).get() as { kind: string };
    expect(r.kind).toBe("page");
  });

  it("an admin-RSC row stores path/country/ASN and nothing else", async () => {
    await writeRequestSample(db as never, {
      kind: ADMIN_RSC_ANON_KIND,
      path: "/admin/claims",
      asn: 13335,
      country: "US",
    });
    const r = raw.prepare(`SELECT * FROM request_samples`).get() as Record<string, unknown>;
    expect(r.kind).toBe("admin_rsc_anon");
    expect(r.path).toBe("/admin/claims");
    expect(r.asn).toBe(13335);
    expect(r.country).toBe("US");
    for (const c of ["user_agent", "ip", "as_organization", "referer", "ray", "method"]) {
      expect(r[c]).toBeNull();
    }
  });

  it("migration 0373 backfills pre-existing rows to 'page'", () => {
    const m = new Database(":memory:");
    m.exec(readFileSync(join(DRIZZLE, "0130_request_samples.sql"), "utf8"));
    m.prepare(`INSERT INTO request_samples (id, timestamp) VALUES ('a', 1)`).run();
    m.exec(readFileSync(join(DRIZZLE, "0373_ope1397_request_samples_kind.sql"), "utf8"));
    expect((m.prepare(`SELECT kind FROM request_samples`).get() as { kind: string }).kind).toBe(
      "page"
    );
    m.close();
  });
});

describe("OPE-1397 — isAnonymousAdminRscRequest", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("matches /admin* with RSC or Next-Router-State-Tree and no session cookie", () => {
    expect(isAnonymousAdminRscRequest("/admin/claims", h({ rsc: "1" }))).toBe(true);
    expect(isAnonymousAdminRscRequest("/admin", h({ "next-router-state-tree": "%5B%5D" }))).toBe(
      true
    );
    expect(
      isAnonymousAdminRscRequest("/admin/x", h({ rsc: "1", cookie: "theme=dark; other=1" }))
    ).toBe(true);
  });

  it("ignores a request with a session cookie (either Auth.js name)", () => {
    for (const cookie of [
      "authjs.session-token=abc",
      "a=1; __Secure-authjs.session-token=abc",
      "next-auth.session-token=abc",
    ]) {
      expect(isAnonymousAdminRscRequest("/admin/claims", h({ rsc: "1", cookie }))).toBe(false);
    }
  });

  it("ignores a plain GET (no RSC headers) and non-admin paths", () => {
    expect(isAnonymousAdminRscRequest("/admin/claims", h({}))).toBe(false);
    expect(isAnonymousAdminRscRequest("/administrator", h({ rsc: "1" }))).toBe(false);
    expect(isAnonymousAdminRscRequest("/api/admin/claims", h({ rsc: "1" }))).toBe(false);
    expect(isAnonymousAdminRscRequest("/vendor/profile", h({ rsc: "1" }))).toBe(false);
  });
});

describe("OPE-971 — truncateIp", () => {
  it.each([
    ["203.0.113.7", "203.0.113.0/24"],
    ["  198.51.100.255 ", "198.51.100.0/24"],
    ["2001:db8:85a3:8d3:1319:8a2e:370:7348", "2001:db8:85a3::/48"],
    ["2001:db8::1", "2001:db8:0::/48"],
    ["", null],
    [null, null],
    ["not-an-ip", null],
  ])("%j → %j", (input, out) => {
    expect(truncateIp(input as string | null)).toBe(out);
  });
});
