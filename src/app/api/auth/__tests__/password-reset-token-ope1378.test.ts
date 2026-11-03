/**
 * OPE-1378 (AUTH8) — password-reset tokens are hashed at rest and consumed
 * atomically.
 *
 * Real SQLite (better-sqlite3 through Drizzle), so the WHERE / DELETE … RETURNING
 * shape itself is under test rather than a mock chain that would pass whatever
 * the query said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";

let db: unknown;
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth", () => ({ hashPassword: vi.fn(async (p: string) => `hashed:${p}`) }));
vi.mock("@/lib/email/undeliverable", () => ({ isAddressUndeliverable: vi.fn(async () => false) }));
vi.mock("@/lib/email/send", () => ({ getSiteUrl: () => "https://site.test" }));
const enqueued: Array<{ text: string; html: string }> = [];
vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: vi.fn(async (args: { text: string; html: string }) => {
    enqueued.push(args);
  }),
}));

import { POST as forgotPOST } from "../forgot-password/route";
import { POST as resetPOST } from "../reset-password/route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let raw: InstanceType<typeof Database>;

const RAW_A = "a".repeat(40) + "-token-one";
const RAW_B = "b".repeat(40) + "-token-two";

function addToken(
  rawToken: string,
  opts: { userId?: string; expiresMs?: number; plain?: boolean } = {}
) {
  raw
    .prepare(
      "INSERT INTO password_reset_tokens (token, user_id, expires, created_at) VALUES (?,?,?,?)"
    )
    .run(
      opts.plain ? rawToken : sha(rawToken),
      opts.userId ?? "u1",
      // `mode: "timestamp"` columns are SECONDS at rest.
      Math.floor((opts.expiresMs ?? Date.now() + 60 * 60 * 1000) / 1000),
      Math.floor(Date.now() / 1000)
    );
}

const tokenRows = () =>
  raw.prepare("SELECT token, user_id FROM password_reset_tokens ORDER BY token").all() as Array<{
    token: string;
    user_id: string;
  }>;
const passwordOf = (id: string) =>
  (raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as { password_hash: string })
    .password_hash;

const resetReq = (token: string, password = "new-password-123") =>
  new NextRequest("https://site.test/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });

beforeEach(() => {
  enqueued.length = 0;
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.users));
  raw.exec(ddlFor(schema.passwordResetTokens));
  raw
    .prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES ('u1','alice@example.com','Alice','old')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES ('u2','bob@example.com','Bob','bob-old')"
    )
    .run();
  db = drizzle(raw, { schema });
});

describe("forgot-password stores only the digest (OPE-1378)", () => {
  it("the stored token is SHA-256 of the token in the emailed link, never the link token itself", async () => {
    const res = await forgotPOST(
      new NextRequest("https://site.test/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com" }),
      })
    );
    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(1);

    const m = enqueued[0].text.match(/\/reset-password\/([A-Za-z0-9-]+)/);
    expect(m).not.toBeNull();
    const linkToken = m![1];

    const rows = tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(sha(linkToken));
    expect(rows[0].token).not.toBe(linkToken);

    // And the link actually works end-to-end.
    const ok = await resetPOST(resetReq(linkToken));
    expect(ok.status).toBe(200);
    expect(passwordOf("u1")).toBe("hashed:new-password-123");
  });
});

describe("reset-password consumes hashed tokens atomically (OPE-1378)", () => {
  it("accepts a valid token once, then refuses the same token", async () => {
    addToken(RAW_A);
    expect((await resetPOST(resetReq(RAW_A))).status).toBe(200);
    expect(passwordOf("u1")).toBe("hashed:new-password-123");

    const again = await resetPOST(resetReq(RAW_A, "second-password-99"));
    expect(again.status).toBe(400);
    expect(passwordOf("u1")).toBe("hashed:new-password-123");
  });

  it("two concurrent requests with one token: exactly one succeeds", async () => {
    addToken(RAW_A);
    const [r1, r2] = await Promise.all([
      resetPOST(resetReq(RAW_A, "concurrent-one-1")),
      resetPOST(resetReq(RAW_A, "concurrent-two-2")),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);
  });

  it("refuses a legacy plaintext-stored token (the presented value is hashed before lookup)", async () => {
    addToken(RAW_A, { plain: true });
    expect((await resetPOST(resetReq(RAW_A))).status).toBe(400);
    expect(passwordOf("u1")).toBe("old");
  });

  it("refuses an expired token and removes it", async () => {
    addToken(RAW_A, { expiresMs: Date.now() - 60_000 });
    const res = await resetPOST(resetReq(RAW_A));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/expired/);
    expect(passwordOf("u1")).toBe("old");
    expect(tokenRows()).toHaveLength(0);
  });

  it("clears the user's OTHER outstanding reset tokens, and leaves other users' alone", async () => {
    addToken(RAW_A);
    addToken(RAW_B);
    addToken("c".repeat(48), { userId: "u2" });

    expect((await resetPOST(resetReq(RAW_A))).status).toBe(200);

    expect(tokenRows().map((r) => r.user_id)).toEqual(["u2"]);
    // The older link for the same account is now dead.
    expect((await resetPOST(resetReq(RAW_B, "via-old-link-1"))).status).toBe(400);
    expect(passwordOf("u1")).toBe("hashed:new-password-123");
    expect(passwordOf("u2")).toBe("bob-old");
  });
});
