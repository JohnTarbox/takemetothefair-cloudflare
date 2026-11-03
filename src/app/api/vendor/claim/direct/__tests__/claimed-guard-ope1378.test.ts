/**
 * OPE-1378 (AUTH7) — the email-match direct claim's UPDATE is guarded by
 * `claimed = false`, like every other claim path, and a 0-row update is a 409.
 *
 * The route reads the vendor, decides, then writes. The race under test is a
 * claim that lands between that read and the write: the test db flips the row
 * to claimed-by-someone-else on the route's first `.update()` call, i.e. after
 * the route's pre-check has already seen `claimed = false`. Real SQLite, so the
 * WHERE clause itself decides the outcome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

let db: unknown;
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", email: "owner@farm.test" } })),
}));
vi.mock("@/lib/completeness", () => ({ recomputeVendorCompleteness: vi.fn(async () => null) }));
vi.mock("@/lib/enrichment-log", () => ({ logEnrichment: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => undefined) }));
vi.mock("@/lib/indexnow", () => ({
  pingIndexNow: vi.fn(async () => undefined),
  indexNowUrlFor: vi.fn(() => "https://x"),
}));

import { POST } from "../route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;

/** Wrap the drizzle db so `beforeFirstUpdate` runs right before the route's first UPDATE. */
function dbWithRace(real: ReturnType<typeof drizzle>, beforeFirstUpdate?: () => void) {
  let fired = false;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "update" && beforeFirstUpdate) {
        return (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            beforeFirstUpdate();
          }
          return (target.update as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const vendorRow = () =>
  raw.prepare("SELECT user_id, claimed, claimed_by FROM vendors WHERE id = 'v1'").get() as {
    user_id: string;
    claimed: number;
    claimed_by: string | null;
  };
const count = (table: string) =>
  (raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

const claim = () =>
  POST(
    new Request("https://site.test/api/vendor/claim/direct", {
      method: "POST",
      body: JSON.stringify({ slug: "acme-farm" }),
    })
  );

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [
    schema.users,
    schema.vendors,
    schema.userRoles,
    schema.entityClaims,
    schema.adminActions,
  ]) {
    raw.exec(ddlFor(t));
  }
  raw
    .prepare("INSERT INTO users (id, email, email_verified) VALUES ('u1','owner@farm.test', ?)")
    .run(Date.now());
  raw
    .prepare("INSERT INTO users (id, email) VALUES ('placeholder','pending+acme-farm@x.test')")
    .run();
  raw.prepare("INSERT INTO users (id, email) VALUES ('intruder','intruder@x.test')").run();
  // The prod shape: every unclaimed vendor is owned by an ingestion placeholder.
  raw
    .prepare(
      "INSERT INTO vendors (id, user_id, business_name, slug, contact_email, claimed) VALUES ('v1','placeholder','Acme Farm','acme-farm','owner@farm.test',0)"
    )
    .run();
});

describe("POST /api/vendor/claim/direct — claimed=false guard (OPE-1378)", () => {
  it("claims an unclaimed (placeholder-owned) listing", async () => {
    db = dbWithRace(drizzle(raw, { schema }));
    const res = await claim();
    expect(res.status).toBe(200);
    expect(vendorRow()).toEqual({ user_id: "u1", claimed: 1, claimed_by: "u1" });
    expect(count("user_roles")).toBe(1);
    expect(count("entity_claims")).toBe(1);
  });

  it("a claim that lands between the pre-check and the UPDATE is NOT overwritten: 409, no side effects", async () => {
    db = dbWithRace(drizzle(raw, { schema }), () => {
      raw
        .prepare(
          "UPDATE vendors SET claimed = 1, user_id = 'intruder', claimed_by = 'intruder' WHERE id = 'v1'"
        )
        .run();
    });
    const res = await claim();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_claimed");
    expect(vendorRow()).toEqual({ user_id: "intruder", claimed: 1, claimed_by: "intruder" });
    expect(count("user_roles")).toBe(0);
    expect(count("entity_claims")).toBe(0);
    expect(count("admin_actions")).toBe(0);
  });

  it("the rightful owner re-claiming an already-claimed listing stays idempotent (200)", async () => {
    raw
      .prepare("UPDATE vendors SET claimed = 1, user_id = 'u1', claimed_by = 'u1' WHERE id = 'v1'")
      .run();
    db = dbWithRace(drizzle(raw, { schema }));
    const res = await claim();
    expect(res.status).toBe(200);
    expect(vendorRow()).toEqual({ user_id: "u1", claimed: 1, claimed_by: "u1" });
  });

  it("a listing already claimed by another account is still refused by the pre-check", async () => {
    raw
      .prepare(
        "UPDATE vendors SET claimed = 1, user_id = 'intruder', claimed_by = 'intruder' WHERE id = 'v1'"
      )
      .run();
    db = dbWithRace(drizzle(raw, { schema }));
    expect((await claim()).status).toBe(409);
    expect(vendorRow().user_id).toBe("intruder");
  });
});
