/**
 * OPE-510 — the audience-list table had no writer on the signup path.
 *
 * `newsletter_list_subscriptions` shipped with OPE-191, whose Scope §1 deferred
 * the public signup form. That was right for the VENDOR list at prototype time
 * — but the same increment switched the WEEKEND broadcast from "all confirmed
 * subscribers" to "members of the `weekend` list", so a deferral scoped to one
 * list became a silent delivery hole on the other. Eight people double-opted-in
 * and received nothing.
 *
 * It hid for eleven days because nothing compared the two counts: the list had
 * 17 members the morning of its backfill and still had 17 a week later, and a
 * number that never moves looks exactly like a number nothing writes to.
 *
 * Re-measured 2026-08-23, two days after that backfill: 29 confirmed-active vs
 * 26 listed — THREE more already stranded. These tests cover the writer, its
 * symmetry, and the canary, because a fix to any one of the three alone leaves
 * the same class open.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  addToList,
  removeFromAllLists,
  listBalance,
  listForSource,
} from "../newsletter-list-membership";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0, unsubscribed INTEGER NOT NULL DEFAULT 0,
    confirmed_at INTEGER, unsubscribed_at INTEGER, created_at INTEGER
  );
  CREATE TABLE newsletter_list_subscriptions (
    id TEXT PRIMARY KEY, subscriber_id TEXT NOT NULL, list TEXT NOT NULL,
    created_at INTEGER NOT NULL, unsubscribed_at INTEGER
  );
  CREATE UNIQUE INDEX idx_newsletter_list_subs_unique
    ON newsletter_list_subscriptions (subscriber_id, list);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let raw: any;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seedSubscriber(
  id: string,
  email: string,
  opts: { confirmed?: boolean; unsubscribed?: boolean } = {}
) {
  raw
    .prepare(
      "INSERT INTO newsletter_subscribers (id,email,source,confirmed,unsubscribed,created_at) VALUES (?,?,?,?,?,?)"
    )
    .run(
      id,
      email,
      "footer",
      opts.confirmed === false ? 0 : 1,
      opts.unsubscribed ? 1 : 0,
      1787000000
    );
}

function rowsFor(subscriberId: string) {
  return raw
    .prepare(
      "SELECT list, unsubscribed_at FROM newsletter_list_subscriptions WHERE subscriber_id = ?"
    )
    .all(subscriberId);
}

describe("listForSource", () => {
  it("routes the ordinary public surfaces to the weekend list", () => {
    expect(listForSource("footer")).toBe("weekend");
    expect(listForSource("event-detail")).toBe("weekend");
    expect(listForSource("blog-post")).toBe("weekend");
  });

  it("defaults an UNKNOWN source to weekend rather than to no list", () => {
    // The defect's exact shape: a new signup surface (OPE-317 adds several)
    // must never produce a confirmed subscriber on NO list. Silently dropping
    // them is what this ticket exists to stop.
    expect(listForSource("some-future-surface")).toBe("weekend");
    expect(listForSource(null)).toBe("weekend");
    expect(listForSource(undefined)).toBe("weekend");
  });

  it("keeps the vendor form separable, so it is a config change later", () => {
    expect(listForSource("vendor-form")).toBe("vendor");
  });
});

describe("addToList", () => {
  it("creates exactly one active row", async () => {
    seedSubscriber("s1", "a@example.com");
    await addToList(db, "s1", "weekend");

    const rows = rowsFor("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].list).toBe("weekend");
    expect(rows[0].unsubscribed_at).toBeNull();
  });

  it("is idempotent — a re-clicked confirmation link must not error or duplicate", async () => {
    seedSubscriber("s1", "a@example.com");
    await addToList(db, "s1", "weekend");
    await addToList(db, "s1", "weekend");

    expect(rowsFor("s1")).toHaveLength(1);
  });

  it("REVIVES a tombstoned row instead of leaving it dead", async () => {
    // The sharp edge. Without clearing `unsubscribed_at` on conflict, a
    // returning subscriber reads confirmed=1/unsubscribed=0, the canary calls
    // it balanced, and the broadcast still skips them — the same invisible
    // state as the original bug, one table over.
    seedSubscriber("s1", "a@example.com");
    await addToList(db, "s1", "weekend");
    await removeFromAllLists(db, "s1");
    expect(rowsFor("s1")[0].unsubscribed_at).not.toBeNull();

    await addToList(db, "s1", "weekend");
    expect(rowsFor("s1")).toHaveLength(1);
    expect(rowsFor("s1")[0].unsubscribed_at).toBeNull();
  });

  it("keeps the two lists independent", async () => {
    seedSubscriber("s1", "a@example.com");
    await addToList(db, "s1", "weekend");
    await addToList(db, "s1", "vendor");

    expect(
      rowsFor("s1")
        .map((r: { list: string }) => r.list)
        .sort()
    ).toEqual(["vendor", "weekend"]);
  });
});

describe("removeFromAllLists", () => {
  it("tombstones every live list a subscriber is on", async () => {
    seedSubscriber("s1", "a@example.com");
    await addToList(db, "s1", "weekend");
    await addToList(db, "s1", "vendor");

    await removeFromAllLists(db, "s1");
    expect(
      rowsFor("s1").every((r: { unsubscribed_at: number | null }) => r.unsubscribed_at !== null)
    ).toBe(true);
  });

  it("does not rewrite an earlier unsubscribe timestamp", async () => {
    // When someone left is a fact worth keeping; a second unsubscribe must not
    // move it forward.
    seedSubscriber("s1", "a@example.com");
    await addToList(db, "s1", "weekend");
    await removeFromAllLists(db, "s1", new Date(1787000000 * 1000));
    const first = rowsFor("s1")[0].unsubscribed_at;

    await removeFromAllLists(db, "s1", new Date(1787999999 * 1000));
    expect(rowsFor("s1")[0].unsubscribed_at).toBe(first);
  });

  it("touches nobody else", async () => {
    seedSubscriber("s1", "a@example.com");
    seedSubscriber("s2", "b@example.com");
    await addToList(db, "s1", "weekend");
    await addToList(db, "s2", "weekend");

    await removeFromAllLists(db, "s1");
    expect(rowsFor("s2")[0].unsubscribed_at).toBeNull();
  });
});

describe("the canary — the comparison nothing was making", () => {
  it("reports the live production shape: orphans are visible", async () => {
    // Three confirmed-active, one listed. Before this ticket every count in
    // the report was individually correct and the gap was invisible.
    seedSubscriber("s1", "a@example.com");
    seedSubscriber("s2", "b@example.com");
    seedSubscriber("s3", "c@example.com");
    await addToList(db, "s1", "weekend");

    const b = await listBalance(db);
    expect(b.confirmed_active).toBe(3);
    expect(b.on_any_list).toBe(1);
    expect(b.orphaned).toBe(2);
    expect(b.balanced).toBe(false);
  });

  it("goes green only when every confirmed subscriber is actually on a list", async () => {
    seedSubscriber("s1", "a@example.com");
    seedSubscriber("s2", "b@example.com");
    await addToList(db, "s1", "weekend");
    await addToList(db, "s2", "weekend");

    expect((await listBalance(db)).balanced).toBe(true);
  });

  it("does not count an unconfirmed subscriber as an orphan", async () => {
    // Someone mid-double-opt-in is not owed mail and must not redden the tile,
    // or the operator learns to ignore it.
    seedSubscriber("s1", "a@example.com", { confirmed: false });
    expect((await listBalance(db)).orphaned).toBe(0);
  });

  it("does not count an unsubscribed subscriber as an orphan", async () => {
    seedSubscriber("s1", "a@example.com", { unsubscribed: true });
    expect((await listBalance(db)).orphaned).toBe(0);
  });

  it("stays balanced across the full subscribe → confirm → unsubscribe → resubscribe cycle", async () => {
    // The ticket's acceptance criterion, end to end.
    seedSubscriber("s1", "a@example.com", { confirmed: false });
    expect((await listBalance(db)).balanced).toBe(true); // unconfirmed: nothing owed

    // confirm
    raw.prepare("UPDATE newsletter_subscribers SET confirmed=1 WHERE id='s1'").run();
    await addToList(db, "s1", listForSource("footer"));
    expect((await listBalance(db)).balanced).toBe(true);

    // unsubscribe — BOTH tables
    raw.prepare("UPDATE newsletter_subscribers SET unsubscribed=1 WHERE id='s1'").run();
    await removeFromAllLists(db, "s1");
    expect((await listBalance(db)).balanced).toBe(true);

    // resubscribe — the case that would break with a blind insert
    raw.prepare("UPDATE newsletter_subscribers SET unsubscribed=0 WHERE id='s1'").run();
    await addToList(db, "s1", listForSource("footer"));
    const final = await listBalance(db);
    expect(final.balanced).toBe(true);
    expect(final.on_any_list).toBe(1);
    expect(rowsFor("s1")).toHaveLength(1);
  });
});
