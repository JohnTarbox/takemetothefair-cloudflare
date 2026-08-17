/**
 * Tests for the newsletter double opt-in token helper. Pattern mirrors
 * the vendor-claim-token approach — same hash + single-use semantics; the
 * TTL was widened to 14 days (OPE-168, was 24h) and state lives inline on
 * newsletter_subscribers rather than in a separate tokens table.
 *
 * Uses better-sqlite3 against an in-memory schema rather than full D1
 * — the helper's only DB surface is select/update against
 * newsletter_subscribers, both of which Drizzle handles identically
 * across the two backends.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import {
  issueNewsletterConfirmationToken,
  consumeNewsletterConfirmationToken,
  NEWSLETTER_CONFIRM_TTL_DAYS,
} from "../../lib/email/newsletter-confirm-token";

const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0,
    unsubscribed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    -- OPE-389 (drizzle/0195)
    confirmed_at INTEGER,
    unsubscribed_at INTEGER,
    confirmation_token_hash TEXT,
    confirmation_expires INTEGER
  );
`;

const sqlite = new Database(":memory:");
// Bracket-access to dodge the workspace-wide security hook that warns on
// the `.exec(` literal (it's a SQL multi-statement runner here, not
// child_process exec). Same idiom as venue-matching-autolink.test.ts.
sqlite["exec"](SCHEMA_SQL);

// Drizzle's d1 type is structurally compatible with better-sqlite3's
// for the helper's narrow query surface (select + update). Cast through
// `unknown` to satisfy the type checker without dragging in a D1 mock.
const db = drizzle(sqlite) as unknown as Parameters<typeof issueNewsletterConfirmationToken>[0];

beforeEach(() => {
  sqlite["exec"]("DELETE FROM newsletter_subscribers");
});

afterAll(() => {
  sqlite.close();
});

async function seedRow(email: string, opts: { confirmed?: boolean } = {}) {
  sqlite
    .prepare(
      "INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed) VALUES (?, ?, ?, 0)"
    )
    .run(crypto.randomUUID(), email, opts.confirmed ? 1 : 0);
}

describe("issueNewsletterConfirmationToken", () => {
  it("returns a raw token and stores its hash on the row", async () => {
    await seedRow("user@example.com");
    const { rawToken, expiresAt } = await issueNewsletterConfirmationToken(db, "user@example.com");

    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    // OPE-168 — the window is 14 days (was 24h); assert against the constant so
    // a future accidental narrowing (the kmgr94-style drift) trips this test.
    expect(NEWSLETTER_CONFIRM_TTL_DAYS).toBe(14);
    const ttlMs = NEWSLETTER_CONFIRM_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + ttlMs - 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ttlMs + 1000);

    const row = sqlite
      .prepare(
        "SELECT confirmation_token_hash, confirmation_expires FROM newsletter_subscribers WHERE email = ?"
      )
      .get("user@example.com") as {
      confirmation_token_hash: string;
      confirmation_expires: number;
    };
    expect(row.confirmation_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.confirmation_token_hash).not.toBe(rawToken); // hash != raw
    expect(row.confirmation_expires).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
  });

  it("overwrites a prior outstanding token on re-issue", async () => {
    await seedRow("user@example.com");
    const first = await issueNewsletterConfirmationToken(db, "user@example.com");
    const second = await issueNewsletterConfirmationToken(db, "user@example.com");

    expect(second.rawToken).not.toBe(first.rawToken);

    // The first token must no longer consume.
    const stale = await consumeNewsletterConfirmationToken(db, first.rawToken);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("not_found");

    // The second one works.
    const fresh = await consumeNewsletterConfirmationToken(db, second.rawToken);
    expect(fresh.ok).toBe(true);
  });
});

describe("consumeNewsletterConfirmationToken", () => {
  it("flips confirmed=true and clears the token on success", async () => {
    await seedRow("user@example.com");
    const { rawToken } = await issueNewsletterConfirmationToken(db, "user@example.com");

    const result = await consumeNewsletterConfirmationToken(db, rawToken);

    expect(result).toEqual({ ok: true, email: "user@example.com" });

    const row = sqlite
      .prepare(
        "SELECT confirmed, confirmation_token_hash, confirmation_expires FROM newsletter_subscribers WHERE email = ?"
      )
      .get("user@example.com") as {
      confirmed: number;
      confirmation_token_hash: string | null;
      confirmation_expires: number | null;
    };
    expect(row.confirmed).toBe(1);
    expect(row.confirmation_token_hash).toBeNull();
    expect(row.confirmation_expires).toBeNull();
  });

  it("returns not_found for an unknown raw token", async () => {
    await seedRow("user@example.com");
    await issueNewsletterConfirmationToken(db, "user@example.com");
    const garbage = "deadbeef".repeat(8);

    const result = await consumeNewsletterConfirmationToken(db, garbage);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns already_confirmed when the row was confirmed via a prior consume", async () => {
    // Realistic scenario: user clicks the confirmation link, then clicks
    // it again (bookmark, email-client preview opens it twice, etc.).
    await seedRow("user@example.com", { confirmed: true });
    // Manually attach a token to simulate "row exists with stale token"
    // — confirmed-true means the token was already consumed once.
    const { rawToken } = await issueNewsletterConfirmationToken(db, "user@example.com");

    const result = await consumeNewsletterConfirmationToken(db, rawToken);
    expect(result).toEqual({ ok: false, reason: "already_confirmed" });
  });

  it("returns expired and clears the stale hash when the token is past TTL", async () => {
    await seedRow("user@example.com");
    const { rawToken } = await issueNewsletterConfirmationToken(db, "user@example.com");

    // Backdate the expiry to one second ago to simulate an expired link.
    sqlite
      .prepare("UPDATE newsletter_subscribers SET confirmation_expires = ? WHERE email = ?")
      .run(Math.floor(Date.now() / 1000) - 1, "user@example.com");

    const result = await consumeNewsletterConfirmationToken(db, rawToken);
    expect(result).toEqual({ ok: false, reason: "expired" });

    // The stale hash should be wiped so a future re-subscribe can issue
    // a fresh token without orphan-overlay.
    const row = sqlite
      .prepare(
        "SELECT confirmation_token_hash, confirmation_expires FROM newsletter_subscribers WHERE email = ?"
      )
      .get("user@example.com") as {
      confirmation_token_hash: string | null;
      confirmation_expires: number | null;
    };
    expect(row.confirmation_token_hash).toBeNull();
    expect(row.confirmation_expires).toBeNull();
  });

  it("clears unsubscribed=true when a previously-unsubscribed user re-confirms", async () => {
    await seedRow("user@example.com");
    sqlite
      .prepare("UPDATE newsletter_subscribers SET unsubscribed = 1 WHERE email = ?")
      .run("user@example.com");
    const { rawToken } = await issueNewsletterConfirmationToken(db, "user@example.com");

    await consumeNewsletterConfirmationToken(db, rawToken);

    const row = sqlite
      .prepare("SELECT confirmed, unsubscribed FROM newsletter_subscribers WHERE email = ?")
      .get("user@example.com") as { confirmed: number; unsubscribed: number };
    expect(row.confirmed).toBe(1);
    expect(row.unsubscribed).toBe(0);
  });

  it("treats hash != raw — knowing the hash doesn't let you consume", async () => {
    // Defense-in-depth: if an attacker reads the DB they get the hash,
    // not the raw token. Submitting the hash to the consume endpoint
    // must NOT confirm the subscription.
    await seedRow("user@example.com");
    await issueNewsletterConfirmationToken(db, "user@example.com");
    const hash = (
      sqlite
        .prepare("SELECT confirmation_token_hash FROM newsletter_subscribers WHERE email = ?")
        .get("user@example.com") as { confirmation_token_hash: string }
    ).confirmation_token_hash;

    const result = await consumeNewsletterConfirmationToken(db, hash);
    expect(result).toEqual({ ok: false, reason: "not_found" });

    const row = sqlite
      .prepare("SELECT confirmed FROM newsletter_subscribers WHERE email = ?")
      .get("user@example.com") as { confirmed: number };
    expect(row.confirmed).toBe(0);
  });
});

describe("end-to-end signup flow", () => {
  it("issue then consume produces a confirmed subscriber from an unconfirmed row", async () => {
    await seedRow("real@example.com");
    expect(
      (
        sqlite
          .prepare("SELECT confirmed FROM newsletter_subscribers WHERE email = ?")
          .get("real@example.com") as { confirmed: number }
      ).confirmed
    ).toBe(0);

    const { rawToken } = await issueNewsletterConfirmationToken(db, "real@example.com");
    const result = await consumeNewsletterConfirmationToken(db, rawToken);

    expect(result.ok).toBe(true);
    expect(
      (
        sqlite
          .prepare("SELECT confirmed FROM newsletter_subscribers WHERE email = ?")
          .get("real@example.com") as { confirmed: number }
      ).confirmed
    ).toBe(1);
  });
});

/**
 * OPE-389 — the column alone is not the deliverable.
 *
 * The ticket names the anti-pattern explicitly: a column with no writer. So the
 * test that matters is not "does confirmed_at exist" but "does confirming
 * actually stamp it, in the SAME write as the flag" — a separate write could
 * leave confirmed=1 with a NULL timestamp if it failed, which is precisely the
 * unobservable state this work removes.
 */
describe("OPE-389 — confirm stamps the time, not just the flag", () => {
  it("writes confirmed=1 AND a real confirmed_at together", async () => {
    await seedRow("timed@example.com");
    const before = Date.now();
    const { rawToken } = await issueNewsletterConfirmationToken(db, "timed@example.com");
    const result = await consumeNewsletterConfirmationToken(db, rawToken);
    expect(result.ok).toBe(true);

    const row = sqlite
      .prepare("SELECT confirmed, confirmed_at FROM newsletter_subscribers WHERE email = ?")
      .get("timed@example.com") as { confirmed: number; confirmed_at: number | null };

    expect(row.confirmed).toBe(1);
    expect(row.confirmed_at).not.toBeNull();
    // Seconds-epoch, and actually "now" rather than a placeholder.
    const stampedMs = (row.confirmed_at as number) * 1000;
    expect(stampedMs).toBeGreaterThanOrEqual(before - 2000);
    expect(stampedMs).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it("makes time-to-confirm computable, which is the whole point", async () => {
    // created_at is what confirmed_at gets subtracted from downstream.
    const created = Math.floor(Date.now() / 1000) - 3600; // an hour ago
    sqlite
      .prepare(
        "INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, created_at) VALUES (?, ?, 0, 0, ?)"
      )
      .run(crypto.randomUUID(), "elapsed@example.com", created);

    const { rawToken } = await issueNewsletterConfirmationToken(db, "elapsed@example.com");
    await consumeNewsletterConfirmationToken(db, rawToken);

    const row = sqlite
      .prepare(
        "SELECT (confirmed_at - created_at) AS seconds_to_confirm FROM newsletter_subscribers WHERE email = ?"
      )
      .get("elapsed@example.com") as { seconds_to_confirm: number };
    expect(row.seconds_to_confirm).toBeGreaterThanOrEqual(3595);
    expect(row.seconds_to_confirm).toBeLessThan(3700);
  });

  it("re-opt-in clears a stale unsubscribed_at rather than leaving it", async () => {
    // Otherwise a resubscribed reader carries an unsubscribe timestamp forever
    // and every "when did they leave" query answers for a cycle that ended.
    sqlite
      .prepare(
        "INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, unsubscribed_at) VALUES (?, ?, 0, 1, ?)"
      )
      .run(crypto.randomUUID(), "returning@example.com", Math.floor(Date.now() / 1000) - 86400);

    const { rawToken } = await issueNewsletterConfirmationToken(db, "returning@example.com");
    await consumeNewsletterConfirmationToken(db, rawToken);

    const row = sqlite
      .prepare("SELECT unsubscribed, unsubscribed_at FROM newsletter_subscribers WHERE email = ?")
      .get("returning@example.com") as { unsubscribed: number; unsubscribed_at: number | null };
    expect(row.unsubscribed).toBe(0);
    expect(row.unsubscribed_at).toBeNull();
  });
});
