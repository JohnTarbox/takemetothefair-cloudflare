/**
 * OPE-1361 — main-app token auth honours revoked_at / expires_at.
 *
 * `revoke_api_token` (MCP) sets `api_tokens.revoked_at`; the MCP Worker refused
 * such a token (OPE-903) but `authenticateVendorToken` looked it up by hash
 * alone, so a revoked token kept working on the main-app token route.
 *
 * Real SQLite, so the WHERE predicate itself is what's under test — a mock
 * `limit()` queue would pass whatever the query said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createHash } from "node:crypto";
import * as schema from "../db/schema";

let db: unknown;
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));

import { authenticateVendorToken } from "../api-token-auth";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;
const nowSec = () => Math.floor(Date.now() / 1000);

function addToken(raw0: string, opts: { revokedAt?: number; expiresAt?: number } = {}) {
  raw
    .prepare(
      "INSERT INTO api_tokens (id, user_id, token_hash, name, revoked_at, expires_at) VALUES (?, 'u1', ?, 'T', ?, ?)"
    )
    .run(
      raw0,
      createHash("sha256").update(raw0).digest("hex"),
      opts.revokedAt ?? null,
      opts.expiresAt ?? null
    );
}

const req = (token: string) =>
  new Request("https://example.com/api/vendors/acme/applications", {
    headers: { Authorization: `Bearer ${token}` },
  });

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.apiTokens));
  raw.exec(ddlFor(schema.vendors));
  raw
    .prepare(
      "INSERT INTO vendors (id, user_id, business_name, slug) VALUES ('v1','u1','Acme','acme')"
    )
    .run();
  db = drizzle(raw, { schema });
});

describe("authenticateVendorToken — revocation and expiry (OPE-1361)", () => {
  it("accepts a live token (no revoked_at, no expires_at)", async () => {
    addToken("mmatf_live");
    expect(await authenticateVendorToken(req("mmatf_live"), "acme")).toEqual({
      authorized: true,
      vendorId: "v1",
    });
  });

  it("accepts a token whose expiry is in the future", async () => {
    addToken("mmatf_future", { expiresAt: nowSec() + 3600 });
    expect(await authenticateVendorToken(req("mmatf_future"), "acme")).toMatchObject({
      authorized: true,
    });
  });

  it("rejects a revoked token exactly like an unknown one", async () => {
    addToken("mmatf_revoked", { revokedAt: nowSec() - 60 });
    expect(await authenticateVendorToken(req("mmatf_revoked"), "acme")).toEqual({
      authorized: false,
      error: "Invalid token",
    });
  });

  it("rejects an expired token exactly like an unknown one", async () => {
    addToken("mmatf_expired", { expiresAt: nowSec() - 60 });
    expect(await authenticateVendorToken(req("mmatf_expired"), "acme")).toEqual({
      authorized: false,
      error: "Invalid token",
    });
  });

  it("still rejects a live token against someone else's vendor slug (IDOR)", async () => {
    addToken("mmatf_live");
    raw
      .prepare(
        "INSERT INTO vendors (id, user_id, business_name, slug) VALUES ('v2','u2','Other','other')"
      )
      .run();
    expect(await authenticateVendorToken(req("mmatf_live"), "other")).toEqual({
      authorized: false,
      error: "Token does not match this vendor",
    });
  });
});
