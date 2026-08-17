/**
 * OPE-191 — audience-list selection, against real SQLite rather than mocks.
 *
 * The existing approve-route test drives `selectBroadcastRecipients` through a
 * hand-built mock chain, which pins call shape but cannot tell you whether the
 * SQL selects the right people. That distinction is the whole risk here: the
 * failure mode is "mailed the wrong audience", and a mock will happily return
 * whatever list you handed it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { selectBroadcastRecipients } from "@/lib/email/newsletter-broadcast";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0,
    unsubscribed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    confirmed_at INTEGER,
    unsubscribed_at INTEGER,
    confirmation_token_hash TEXT,
    confirmation_expires INTEGER
  );
  CREATE TABLE newsletter_list_subscriptions (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL,
    list TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    unsubscribed_at INTEGER,
    UNIQUE (subscriber_id, list)
  );
  CREATE TABLE email_suppression_list (
    email TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

function sub(
  id: string,
  email: string,
  opts: { confirmed?: boolean; unsubscribed?: boolean } = {}
) {
  raw
    .prepare(
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed) VALUES (?, ?, ?, ?)`
    )
    .run(id, email, opts.confirmed === false ? 0 : 1, opts.unsubscribed ? 1 : 0);
}

function join(subscriberId: string, list: string, unsubscribedAt: number | null = null) {
  raw
    .prepare(
      `INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(`${subscriberId}-${list}`, subscriberId, list, 0, unsubscribedAt);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("selectBroadcastRecipients — audience isolation (OPE-191)", () => {
  it("keeps the two lists independent, which is the acceptance criterion", () => {
    sub("a", "attendee@example.com");
    sub("v", "vendor@example.com");
    sub("b", "both@example.com");
    join("a", "weekend");
    join("v", "vendor");
    join("b", "weekend");
    join("b", "vendor");

    return Promise.all([
      selectBroadcastRecipients(db as never, "weekend"),
      selectBroadcastRecipients(db as never, "vendor"),
    ]).then(([weekend, vendor]) => {
      expect(weekend.sort()).toEqual(["attendee@example.com", "both@example.com"]);
      expect(vendor.sort()).toEqual(["both@example.com", "vendor@example.com"]);
    });
  });

  it("does NOT mail a subscriber who is on no list", async () => {
    // The pre-OPE-191 behaviour was "every confirmed subscriber". If that
    // leaked back in, this address would receive a vendor digest it never
    // asked for — the exact failure the list dimension exists to prevent.
    sub("x", "nolist@example.com");
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
  });

  it("honours a GLOBAL unsubscribe even with an active list row", async () => {
    // One-click unsubscribe must mean "stop all mail". A stale list row must
    // never resurrect someone.
    sub("u", "gone@example.com", { unsubscribed: true });
    join("u", "vendor");
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
  });

  it("honours a PER-LIST unsubscribe without touching the other list", async () => {
    sub("p", "partial@example.com");
    join("p", "weekend");
    join("p", "vendor", 1_000);
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
    expect(await selectBroadcastRecipients(db as never, "weekend")).toEqual([
      "partial@example.com",
    ]);
  });

  it("excludes unconfirmed subscribers", async () => {
    sub("n", "unconfirmed@example.com", { confirmed: false });
    join("n", "vendor");
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
  });

  it("still applies the suppression list", async () => {
    // A hard bounce suppressed anywhere must be honoured on every list.
    sub("s", "bounced@example.com");
    join("s", "vendor");
    raw.prepare(`INSERT INTO email_suppression_list (email) VALUES (?)`).run("bounced@example.com");
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
  });

  it("matches suppression case-insensitively", async () => {
    sub("c", "Mixed@Example.com");
    join("c", "vendor");
    raw.prepare(`INSERT INTO email_suppression_list (email) VALUES (?)`).run("mixed@example.com");
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
  });

  it("returns empty for a list nobody has joined, rather than everyone", async () => {
    sub("a", "attendee@example.com");
    join("a", "weekend");
    expect(await selectBroadcastRecipients(db as never, "vendor")).toEqual([]);
  });
});
