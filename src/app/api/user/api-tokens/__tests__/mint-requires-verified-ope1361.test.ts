/**
 * OPE-1361 — minting an API token requires a verified email.
 *
 * A token is a standing credential for vendor writes on the token route; an
 * account that never proved email control used to be able to mint one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

let db: unknown;
let sessionUser: { id: string; email: string } | null = null;

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => (sessionUser ? { user: sessionUser } : null)),
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

function mintRequest() {
  return new Request("https://example.com/api/user/api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "t" }),
  }) as unknown as Parameters<typeof POST>[0];
}

const tokenCount = () =>
  (raw.prepare("SELECT COUNT(*) AS n FROM api_tokens").get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.users));
  raw.exec(ddlFor(schema.apiTokens));
  raw
    .prepare("INSERT INTO users (id, email, email_verified) VALUES ('ok','ok@x.com', 1780000000)")
    .run();
  raw.prepare("INSERT INTO users (id, email, email_verified) VALUES ('nv','nv@x.com', NULL)").run();
  db = drizzle(raw, { schema });
});

describe("POST /api/user/api-tokens (OPE-1361)", () => {
  it("refuses an unverified account with 403 email_unverified and mints nothing", async () => {
    sessionUser = { id: "nv", email: "nv@x.com" };
    const res = await POST(mintRequest());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("email_unverified");
    expect(tokenCount()).toBe(0);
  });

  it("refuses no session with 401", async () => {
    sessionUser = null;
    const res = await POST(mintRequest());
    expect(res.status).toBe(401);
    expect(tokenCount()).toBe(0);
  });

  it("mints for a verified account", async () => {
    sessionUser = { id: "ok", email: "ok@x.com" };
    const res = await POST(mintRequest());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^mmatf_[0-9a-f]{40}$/);
    expect(tokenCount()).toBe(1);
  });
});
