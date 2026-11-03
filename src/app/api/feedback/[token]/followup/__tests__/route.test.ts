/**
 * OPE-1377 — POST /api/feedback/[token]/followup.
 *
 * The one-time feedback token is the only authorization for writing a
 * sender-feedback row (the highest-trust intent label, spec §D.3). Negative:
 * used / expired / unknown tokens → 410 and nothing is written. Positive: a
 * live token writes one sender_feedback row + the intent fan-out, then is spent.
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
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "Mozilla/5.0 (Macintosh)" }),
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
const LIVE = "live-feedback-token-0123456789";
const USED = "used-feedback-token-0123456789";
const EXPIRED = "expired-feedback-token-012345";

function post(token: string) {
  const form = new URLSearchParams({ v: "wrong_intent", intendedIntent: "correction" });
  return POST(
    new NextRequest(`https://example.com/api/feedback/${token}/followup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    { params: Promise.resolve({ token }) }
  );
}

const count = (table: string) =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(schema.inboundEmails));
  raw.exec(ddlFor(schema.inboundEmailFeedbackTokens));
  raw.exec(ddlFor(schema.inboundEmailSenderFeedback));
  raw.exec(ddlFor(schema.inboundEmailIntentFeedback));
  raw
    .prepare(
      "INSERT INTO inbound_emails (id, classified_intent, classifier_version) VALUES ('ie1', 'new_event', 'v1')"
    )
    .run();
  const ins = raw.prepare(
    "INSERT INTO inbound_email_feedback_tokens (token, inbound_email_id, feedback_moment, resulting_event_id, issued_at, expires_at, used_at) VALUES (?, 'ie1', 'receipt', NULL, ?, ?, ?)"
  );
  ins.run(LIVE, nowSec(), nowSec() + 3600, null);
  ins.run(USED, nowSec(), nowSec() + 3600, nowSec() - 5);
  ins.run(EXPIRED, nowSec() - 7200, nowSec() - 60, null);
  db = drizzle(raw, { schema });
});

describe("POST /api/feedback/[token]/followup (OPE-1377)", () => {
  it.each([
    ["already-used", USED],
    ["expired", EXPIRED],
    ["unknown", "unknown-feedback-token-01234"],
  ])("%s token → 410 and writes no feedback", async (_label, token) => {
    const res = await post(token);
    expect(res.status).toBe(410);
    expect(count("inbound_email_sender_feedback")).toBe(0);
    expect(count("inbound_email_intent_feedback")).toBe(0);
  });

  it("live token writes sender + intent feedback, redirects, and is then spent", async () => {
    const res = await post(LIVE);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.com/feedback/thanks");
    expect(
      raw
        .prepare(
          "SELECT inbound_email_id, feedback_value, intended_intent FROM inbound_email_sender_feedback"
        )
        .all()
    ).toEqual([
      { inbound_email_id: "ie1", feedback_value: "wrong_intent", intended_intent: "correction" },
    ]);
    expect(
      raw
        .prepare(
          "SELECT feedback_source, original_intent, corrected_intent FROM inbound_email_intent_feedback"
        )
        .all()
    ).toEqual([
      {
        feedback_source: "sender_feedback",
        original_intent: "new_event",
        corrected_intent: "correction",
      },
    ]);

    const replay = await post(LIVE);
    expect(replay.status).toBe(410);
    expect(count("inbound_email_sender_feedback")).toBe(1);
  });
});
