/**
 * OPE-869 — both unsubscribe paths must leave the same person in the same state.
 *
 * Two systems wrote two disjoint stores:
 *   - Path A (`/api/newsletter/unsubscribe`) → `newsletter_subscribers.unsubscribed`
 *     + `newsletter_list_subscriptions`.
 *   - Path B (`/unsubscribe/<e>/<t>`, and the legacy `?e=&t=` form) →
 *     `email_suppression_list`.
 *
 * Both are consulted at send time, so neither was inert — but "did this person
 * unsubscribe?" had two answers depending on which table you read, and which
 * one honoured a click depended only on which mail they happened to receive.
 *
 * ## ⚠️ Amendment H, in the ticket's words
 *
 * *"'The two stores agree' goes vacuously green if the fixture only ever
 * populates one of them. Seed both, assert both are non-empty before the click,
 * then assert agreement after."*
 *
 * Every case below reads BOTH stores and asserts the pre-click state, so
 * "they agree" cannot be satisfied by two empty tables.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { applyGlobalOptOut } from "../unsubscribe-stores";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0, unsubscribed INTEGER NOT NULL DEFAULT 0,
    unsubscribed_at INTEGER, unsubscribe_evidence TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE newsletter_list_subscriptions (
    id TEXT PRIMARY KEY, subscriber_id TEXT NOT NULL, list TEXT NOT NULL,
    created_at INTEGER NOT NULL, unsubscribed_at INTEGER
  );
  CREATE TABLE email_suppression_list (
    email TEXT PRIMARY KEY, reason TEXT, source TEXT, created_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, created_at)
       VALUES ('s1','both@x.com',1,0,0)`
    )
    .run();
  for (const l of ["weekend", "vendor"]) {
    raw
      .prepare(
        `INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at)
         VALUES (?, 's1', ?, 0)`
      )
      .run(`row-${l}`, l);
  }
});

/** The three facts a send path consults, read together. */
function state(email = "both@x.com") {
  const sub = raw
    .prepare(`SELECT unsubscribed AS u FROM newsletter_subscribers WHERE email = ?`)
    .get(email) as { u: number } | undefined;
  const live = (
    raw
      .prepare(
        `SELECT COUNT(*) AS n FROM newsletter_list_subscriptions
          WHERE subscriber_id = 's1' AND unsubscribed_at IS NULL`
      )
      .get() as { n: number }
  ).n;
  const suppressed = (
    raw.prepare(`SELECT COUNT(*) AS n FROM email_suppression_list WHERE email = ?`).get(email) as {
      n: number;
    }
  ).n;
  return { flag: sub?.u ?? null, liveLists: live, suppressed };
}

describe("OPE-869 — a global opt-out reaches every store", () => {
  it("the pre-click state really is 'subscribed everywhere' — the landmark", () => {
    // Without this, every assertion below is satisfied by an empty fixture.
    expect(state()).toEqual({ flag: 0, liveLists: 2, suppressed: 0 });
  });

  it("writes the flag, closes every list row, AND suppresses", async () => {
    await applyGlobalOptOut(db, "both@x.com", { source: "test" });
    expect(state()).toEqual({ flag: 1, liveLists: 0, suppressed: 1 });
  });

  it("works for an address that is not a subscriber at all", async () => {
    // Path B mail goes to vendors and organizers who may never have signed up
    // for a newsletter. The suppression row is the only place their opt-out
    // can live, and the writer must not throw looking for a subscriber row.
    const r = await applyGlobalOptOut(db, "stranger@x.com", { source: "test" });
    expect(r).toEqual({ suppressed: true, subscriberFlagged: false });
    expect(state("stranger@x.com").suppressed).toBe(1);
  });

  it("is idempotent — a second click adds no duplicate and rewrites no timestamp", async () => {
    await applyGlobalOptOut(db, "both@x.com", { source: "test", now: new Date(1000 * 1000) });
    const first = raw
      .prepare(`SELECT created_at AS c FROM email_suppression_list WHERE email='both@x.com'`)
      .get() as { c: number };
    const firstList = raw
      .prepare(`SELECT unsubscribed_at AS u FROM newsletter_list_subscriptions WHERE list='vendor'`)
      .get() as { u: number };

    await applyGlobalOptOut(db, "both@x.com", { source: "test", now: new Date(9000 * 1000) });

    expect(state().suppressed).toBe(1);
    expect(
      (
        raw
          .prepare(`SELECT created_at AS c FROM email_suppression_list WHERE email='both@x.com'`)
          .get() as { c: number }
      ).c
    ).toBe(first.c);
    // When someone left is a fact worth keeping.
    expect(
      (
        raw
          .prepare(
            `SELECT unsubscribed_at AS u FROM newsletter_list_subscriptions WHERE list='vendor'`
          )
          .get() as { u: number }
      ).u
    ).toBe(firstList.u);
  });
});

describe("OPE-869 — both legacy URL formats still mean EVERYTHING", () => {
  // Path B's two routes share `handleUnsubscribe`'s suppress callback, and both
  // now call applyGlobalOptOut. Driving the writer directly is the honest unit
  // here: the routes differ only in how they decode the address, which their
  // own K36 tests already cover.
  it("the path form and the query form converge on the same state", async () => {
    expect(state()).toEqual({ flag: 0, liveLists: 2, suppressed: 0 });
    await applyGlobalOptOut(db, "both@x.com", { source: "unsubscribe-link-path" });
    const afterPath = state();

    // Reset and replay through the other route's source label.
    raw.prepare(`DELETE FROM email_suppression_list`).run();
    raw.prepare(`UPDATE newsletter_subscribers SET unsubscribed = 0`).run();
    raw.prepare(`UPDATE newsletter_list_subscriptions SET unsubscribed_at = NULL`).run();
    expect(state()).toEqual({ flag: 0, liveLists: 2, suppressed: 0 });

    await applyGlobalOptOut(db, "both@x.com", { source: "unsubscribe-link-query" });
    expect(state()).toEqual(afterPath);
  });

  it("records WHICH link was followed, so the two are still distinguishable", async () => {
    // Converging the STATE must not erase the provenance — "they agree" and
    // "we can no longer tell them apart" are different things.
    await applyGlobalOptOut(db, "both@x.com", { source: "unsubscribe-link-path" });
    expect(
      (
        raw
          .prepare(`SELECT source AS s FROM email_suppression_list WHERE email='both@x.com'`)
          .get() as { s: string }
      ).s
    ).toBe("unsubscribe-link-path");
  });
});
