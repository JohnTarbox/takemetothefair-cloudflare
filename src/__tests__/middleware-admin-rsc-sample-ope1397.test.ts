/**
 * OPE-1397 (EXP5) — the real middleware records an anonymous RSC request to
 * /admin* (path, timestamp, country, ASN only), and only that shape.
 *
 * Runs the actual `middleware()` export against an in-memory sqlite built
 * from the real migrations, so a matcher/branch-order change that stops the
 * write from executing turns this red.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("drizzle-orm/d1", async () => {
  const sqlite = await import("drizzle-orm/better-sqlite3");
  return { drizzle: (client: Database.Database) => sqlite.drizzle(client) };
});

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, middleware } from "../middleware";
import { REQUEST_SAMPLE_RATE } from "@/lib/request-sampling";

const ORIGIN = "https://meetmeatthefair.com";
const DRIZZLE = join(__dirname, "..", "..", "drizzle");

let db: Database.Database;
let pending: Promise<unknown>[];

beforeEach(() => {
  db = new Database(":memory:");
  for (const f of ["0130_request_samples.sql", "0373_ope1397_request_samples_kind.sql"]) {
    db.exec(readFileSync(join(DRIZZLE, f), "utf8"));
  }
  pending = [];
  vi.mocked(getCloudflareContext).mockReturnValue({
    env: { DB: db },
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
    },
    cf: { asn: 64500, country: "US", asOrganization: "EXAMPLE-NET" },
  } as never);
  // Keep the 5% A9 page sampler out of the picture.
  vi.spyOn(Math, "random").mockReturnValue(Math.min(0.99, REQUEST_SAMPLE_RATE + 0.5));
});

async function hit(path: string, headers: Record<string, string>) {
  const res = await middleware(new NextRequest(`${ORIGIN}${path}`, { headers }));
  await Promise.all(pending);
  return res;
}

const rows = () =>
  db.prepare(`SELECT * FROM request_samples ORDER BY path`).all() as Record<string, unknown>[];

describe("middleware — anonymous RSC hits on /admin (OPE-1397)", () => {
  it("records an RSC request with no session cookie: path/country/ASN/timestamp only", async () => {
    const res = await hit("/admin/claims", {
      rsc: "1",
      "next-router-state-tree": "%5B%22%22%5D",
      "user-agent": "curl/8",
      "cf-connecting-ip": "203.0.113.9",
      "cf-ipcountry": "CA",
      referer: "https://evil.example/",
    });
    expect(res.headers.get("location")).toBeNull(); // routing unchanged
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: "admin_rsc_anon",
      path: "/admin/claims",
      asn: 64500,
      country: "CA",
      user_agent: null,
      ip: null,
      as_organization: null,
      referer: null,
      ray: null,
      method: null,
    });
    expect(typeof r[0].timestamp).toBe("number");
  });

  it("records the bare /admin path with only Next-Router-State-Tree", async () => {
    await hit("/admin", { "next-router-state-tree": "x" });
    expect(rows().map((r) => r.path)).toEqual(["/admin"]);
  });

  it("the matcher actually invokes middleware on /admin and /admin/* (so the write can run)", () => {
    const matches = (path: string) =>
      unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}` });
    expect(matches("/admin")).toBe(true);
    expect(matches("/admin/claims")).toBe(true);
    expect(matches("/admin/events/abc/edit")).toBe(true);
  });

  it("does NOT record a signed-in admin's RSC navigation", async () => {
    await hit("/admin/claims", { rsc: "1", cookie: "__Secure-authjs.session-token=abc" });
    expect(rows()).toHaveLength(0);
  });

  it("does NOT record a plain signed-out GET of /admin (no RSC headers)", async () => {
    await hit("/admin/claims", {});
    expect(rows()).toHaveLength(0);
  });
});
