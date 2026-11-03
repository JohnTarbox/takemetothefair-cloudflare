/**
 * OPE-1509 — the `outreach-reply-link` probe.
 *
 * Red when an inbound THREADS to one of our outreach sends (ledger
 * provider_message_id, stored with angle brackets as prod stores it) while the
 * ask it answers is still `sent`. Healthy once the ask has moved on. Every case
 * states what it seeded before trusting the verdict.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const SCHEMA_SQL = `
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, in_reply_to TEXT, email_references TEXT
  );
  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY, recipient TEXT, source TEXT, provider_message_id TEXT
  );
  CREATE TABLE promoter_outreach_attempts (
    id TEXT PRIMARY KEY, to_address TEXT NOT NULL, status TEXT NOT NULL, sent_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "outreach-reply-link")!;
const ID = "<w8voNnJb@meetmeatthefair.com>";
const RECEIVED = "2026-10-20T13:40:00Z";

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(
      `INSERT INTO email_send_ledger VALUES ('l1', 'info@usathanksgiving.com', 'email:promoter-outreach', ?)`
    )
    .run(ID);
});

const attempt = (status: string) =>
  raw
    .prepare(
      `INSERT INTO promoter_outreach_attempts VALUES ('a1', 'INFO@usathanksgiving.com', ?, ?)`
    )
    .run(status, T("2026-10-20T12:38:00Z"));
const reply = (inReplyTo: string | null, refs: string | null = null) =>
  raw
    .prepare(`INSERT INTO inbound_emails VALUES ('in1', ?, ?, ?)`)
    .run(T(RECEIVED), inReplyTo, refs);

describe("OPE-1509 — outreach-reply-link probe", () => {
  it("is registered", () => expect(probe).toBeDefined());

  it("RED: a threaded reply to an ask that is still `sent` reads as silence since the reply", async () => {
    attempt("sent");
    reply(ID);
    expect((await probe.lastEvidenceAt(db))!.toISOString()).toBe(new Date(RECEIVED).toISOString());
  });

  it("RED via References too (a client that drops In-Reply-To)", async () => {
    attempt("sent");
    reply(null, `<other@x> ${ID}`);
    expect((await probe.lastEvidenceAt(db))!.toISOString()).toBe(new Date(RECEIVED).toISOString());
  });

  it("healthy once the ask is `replied` (the same reply, linked)", async () => {
    attempt("replied");
    reply(ID);
    const t = await probe.lastEvidenceAt(db);
    expect(Date.now() - t!.getTime()).toBeLessThan(5_000);
  });

  it("healthy when no inbound threads to an outreach send", async () => {
    attempt("sent");
    reply("<unrelated@example.org>");
    const t = await probe.lastEvidenceAt(db);
    expect(Date.now() - t!.getTime()).toBeLessThan(5_000);
  });
});
