/**
 * OPE-1377 — POST /api/submit-event/[token] (B4 correction form).
 *
 * The token in the path is the only authorization for editing a live event,
 * so a used or expired token must never write. Negative: unknown → 404,
 * used/expired → 410, and the event row is untouched. Positive: a live token
 * applies the edit once and is marked used (a second POST → 410).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";

let db: unknown;
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
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
const nowSec = () => Math.floor(Date.now() / 1000);
const LIVE = "live-token-0123456789abcdef";
const USED = "used-token-0123456789abcdef";
const EXPIRED = "expired-token-0123456789abc";

const post = (token: string, body: unknown = { name: "Corrected Fair" }) =>
  POST(
    new NextRequest(`https://example.com/api/submit-event/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) }
  );

const eventName = () =>
  (raw.prepare("SELECT name FROM events WHERE id = 'e1'").get() as { name: string }).name;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.events));
  raw.exec(ddlFor(schema.submissionCorrectionTokens));
  raw
    .prepare("INSERT INTO events (id, name, slug) VALUES ('e1', 'Original Fair', 'original')")
    .run();
  const ins = raw.prepare(
    "INSERT INTO submission_correction_tokens (token, event_id, inbound_email_id, expires_at, used_at, created_at) VALUES (?, 'e1', 'ie1', ?, ?, ?)"
  );
  ins.run(LIVE, nowSec() + 3600, null, nowSec());
  ins.run(USED, nowSec() + 3600, nowSec() - 10, nowSec());
  ins.run(EXPIRED, nowSec() - 60, null, nowSec() - 3600);
  db = drizzle(raw, { schema });
});

describe("POST /api/submit-event/[token] (OPE-1377)", () => {
  it("unknown token → 404, event untouched", async () => {
    const res = await post("unknown-token-0123456789ab");
    expect(res.status).toBe(404);
    expect(eventName()).toBe("Original Fair");
  });

  it("already-used token → 410, event untouched", async () => {
    const res = await post(USED);
    expect(res.status).toBe(410);
    expect(eventName()).toBe("Original Fair");
  });

  it("expired token → 410, event untouched", async () => {
    const res = await post(EXPIRED);
    expect(res.status).toBe(410);
    expect(eventName()).toBe("Original Fair");
  });

  it("live token applies the correction once; the replay is refused", async () => {
    const res = await post(LIVE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, fieldsUpdated: 1 });
    expect(eventName()).toBe("Corrected Fair");
    const usedAt = (
      raw.prepare("SELECT used_at FROM submission_correction_tokens WHERE token = ?").get(LIVE) as {
        used_at: number | null;
      }
    ).used_at;
    expect(usedAt).not.toBeNull();

    const replay = await post(LIVE, { name: "Second Edit" });
    expect(replay.status).toBe(410);
    expect(eventName()).toBe("Corrected Fair");
  });
});
