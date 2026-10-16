/**
 * OPE-1377 — POST /api/admin/users/[id]/mark-verified.
 *
 * Admin-only escape hatch that sets `users.email_verified`. Email verification
 * is the proof several claim rungs rely on, so a non-admin reaching this would
 * be a privilege escalation. Negative: no session / non-admin role → 401 and
 * the row is untouched. Positive: an admin flips it and an audit row lands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";

let db: unknown;
let session: { user: { id: string; roles: string[] } } | null = null;

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => session),
  hasRole: (s: { user?: { roles?: string[] } } | null, role: string) =>
    !!s?.user?.roles?.includes(role),
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

const call = (id = "u1") =>
  POST(
    new NextRequest(`https://example.com/api/admin/users/${id}/mark-verified`, { method: "POST" }),
    { params: Promise.resolve({ id }) }
  );

const verifiedAt = () =>
  (
    raw.prepare("SELECT email_verified AS v FROM users WHERE id = 'u1'").get() as {
      v: number | null;
    }
  ).v;
const auditCount = () =>
  (raw.prepare("SELECT COUNT(*) AS n FROM admin_actions").get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.users));
  raw.exec(ddlFor(schema.adminActions));
  raw.prepare("INSERT INTO users (id, email, email_verified) VALUES ('u1','u1@x.com', NULL)").run();
  db = drizzle(raw, { schema });
  session = null;
});

describe("POST /api/admin/users/[id]/mark-verified (OPE-1377)", () => {
  it("401 with no session — the user stays unverified", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(verifiedAt()).toBeNull();
    expect(auditCount()).toBe(0);
  });

  it("401 for a signed-in non-admin — the user stays unverified", async () => {
    session = { user: { id: "v1", roles: ["USER", "VENDOR", "PROMOTER"] } };
    const res = await call();
    expect(res.status).toBe(401);
    expect(verifiedAt()).toBeNull();
    expect(auditCount()).toBe(0);
  });

  it("admin marks the user verified and writes one admin_actions audit row", async () => {
    session = { user: { id: "admin1", roles: ["ADMIN"] } };
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; email: string };
    expect(body).toMatchObject({ success: true, email: "u1@x.com" });
    expect(verifiedAt()).not.toBeNull();
    const audit = raw.prepare("SELECT action, actor_user_id, target_id FROM admin_actions").all();
    expect(audit).toEqual([
      { action: "user.email_verified_manual", actor_user_id: "admin1", target_id: "u1" },
    ]);
  });

  it("admin on an unknown id → 404", async () => {
    session = { user: { id: "admin1", roles: ["ADMIN"] } };
    const res = await call("nope");
    expect(res.status).toBe(404);
  });
});
