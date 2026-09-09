/**
 * OPE-864 — one unsubscribe click must not empty both newsletters.
 *
 * ## What was broken
 *
 * The unsubscribe route did two globally-scoped things per click: it set
 * `newsletter_subscribers.unsubscribed = true`, and it called a function named
 * `removeFromAllLists`. `selectBroadcastRecipients` requires BOTH that flag to
 * be false AND a live `newsletter_list_subscriptions` row, so either one alone
 * is a kill-switch across every list.
 *
 * A vendor clicking "unsubscribe" in the vendor digest was therefore also
 * removed from the weekend digest, against John's 2026-08-21 requirement that
 * the two lists be "completely separate".
 *
 * ## ⚠️ Amendment H — the trap in this particular suite
 *
 * "The weekend subscription is left intact" passes vacuously if the fixture
 * never created a weekend subscription. So every such assertion here is
 * preceded by an assertion that the row exists and is LIVE *before* the click.
 * Without that, deleting the entire list table would make this file green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../newsletter-unsubscribe-token";

const SECRET = "test-secret-value-for-hmac";

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
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({ NEWSLETTER_UNSUBSCRIBE_SECRET: SECRET }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("@/lib/email/send", () => ({ getSiteUrl: () => "https://meetmeatthefair.com" }));

const { GET } = await import("@/app/api/newsletter/unsubscribe/route");

function seedSubscriber(email: string, lists: string[]) {
  raw
    .prepare(
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, created_at)
       VALUES ('sub1', ?, 1, 0, 0)`
    )
    .run(email);
  for (const l of lists) {
    raw
      .prepare(
        `INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at)
         VALUES (?, 'sub1', ?, 0)`
      )
      .run(`row-${l}`, l);
  }
}

/** Live = still subscribed. NULL unsubscribed_at is what the broadcast requires. */
const isLive = (list: string): boolean => {
  const row = raw
    .prepare(`SELECT unsubscribed_at AS u FROM newsletter_list_subscriptions WHERE list = ?`)
    .get(list) as { u: number | null } | undefined;
  return !!row && row.u === null;
};

const globalFlag = (): number =>
  (raw.prepare(`SELECT unsubscribed AS u FROM newsletter_subscribers`).get() as { u: number }).u;

async function click(token: string) {
  const req = new Request(`https://meetmeatthefair.com/api/newsletter/unsubscribe?token=${token}`);
  return GET(req as never);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("OPE-864 — the token carries a signed list", () => {
  it("a legacy token (no list) verifies and reports list: null", async () => {
    const t = await signUnsubscribeToken("a@x.com", SECRET);
    await expect(verifyUnsubscribeToken(t, SECRET)).resolves.toEqual({
      email: "a@x.com",
      list: null,
    });
  });

  it("a scoped token round-trips the list", async () => {
    const t = await signUnsubscribeToken("a@x.com", SECRET, "vendor");
    await expect(verifyUnsubscribeToken(t, SECRET)).resolves.toEqual({
      email: "a@x.com",
      list: "vendor",
    });
  });

  it("the list is INSIDE the signature — swapping it invalidates the token", async () => {
    // If the list travelled as a URL parameter instead, anyone holding someone
    // else's link could change ?list=vendor to ?list=weekend and unsubscribe
    // them from a list they never asked to leave.
    const vendorTok = await signUnsubscribeToken("a@x.com", SECRET, "vendor");
    const weekendTok = await signUnsubscribeToken("a@x.com", SECRET, "weekend");
    const forged = `${weekendTok.split(".")[0]}.${vendorTok.split(".")[1]}`;
    await expect(verifyUnsubscribeToken(forged, SECRET)).resolves.toBeNull();
  });

  it("normalizes the address before signing", async () => {
    const t = await signUnsubscribeToken("  A@X.CoM ", SECRET, "vendor");
    await expect(verifyUnsubscribeToken(t, SECRET)).resolves.toEqual({
      email: "a@x.com",
      list: "vendor",
    });
  });
});

describe("OPE-864 — a scoped click leaves the other list alone", () => {
  beforeEach(() => seedSubscriber("both@x.com", ["weekend", "vendor"]));

  it("unsubscribing from the VENDOR digest keeps the weekend subscription", async () => {
    // ⚠️ The landmark. Without these two lines the assertions below pass on an
    // empty table, and the whole test means nothing.
    expect(isLive("weekend")).toBe(true);
    expect(isLive("vendor")).toBe(true);

    await click(await signUnsubscribeToken("both@x.com", SECRET, "vendor"));

    expect(isLive("vendor")).toBe(false);
    expect(isLive("weekend")).toBe(true);
  });

  it("and the same in the other direction", async () => {
    expect(isLive("weekend")).toBe(true);
    expect(isLive("vendor")).toBe(true);

    await click(await signUnsubscribeToken("both@x.com", SECRET, "weekend"));

    expect(isLive("weekend")).toBe(false);
    expect(isLive("vendor")).toBe(true);
  });

  it("does NOT set the global kill-switch while another list is still live", async () => {
    // The crux. `selectBroadcastRecipients` requires `unsubscribed = false` AND
    // a live list row, so setting the flag here would silently un-subscribe the
    // person from the other newsletter anyway — the same defect, one line down.
    await click(await signUnsubscribeToken("both@x.com", SECRET, "vendor"));
    expect(globalFlag()).toBe(0);
  });

  it("DOES set the global flag once the last list is gone", async () => {
    await click(await signUnsubscribeToken("both@x.com", SECRET, "vendor"));
    expect(globalFlag()).toBe(0);

    await click(await signUnsubscribeToken("both@x.com", SECRET, "weekend"));
    expect(globalFlag()).toBe(1);
    expect(isLive("weekend")).toBe(false);
    expect(isLive("vendor")).toBe(false);
  });
});

describe("OPE-864 — legacy tokens still mean EVERYTHING", () => {
  beforeEach(() => seedSubscriber("both@x.com", ["weekend", "vendor"]));

  it("a token signed before this change removes both lists and sets the flag", async () => {
    // Links already delivered were sent under a promise that clicking stops all
    // our mail. Narrowing one to a single list would leave someone subscribed
    // who believes they unsubscribed — strictly worse than the bug being fixed.
    expect(isLive("weekend")).toBe(true);
    expect(isLive("vendor")).toBe(true);

    await click(await signUnsubscribeToken("both@x.com", SECRET)); // no list arg

    expect(isLive("weekend")).toBe(false);
    expect(isLive("vendor")).toBe(false);
    expect(globalFlag()).toBe(1);
  });
});

describe("OPE-864 — the pre-existing contract is unchanged", () => {
  it("an invalid token changes nothing", async () => {
    seedSubscriber("both@x.com", ["weekend", "vendor"]);
    await click("not-a-real-token");
    expect(isLive("weekend")).toBe(true);
    expect(isLive("vendor")).toBe(true);
    expect(globalFlag()).toBe(0);
  });

  it("an address that is not subscribed still resolves benignly", async () => {
    // Never reveal subscription status.
    const res = await click(await signUnsubscribeToken("stranger@x.com", SECRET, "vendor"));
    expect(res.status).toBe(303);
    expect(String(res.headers.get("location"))).toContain("status=ok");
  });

  it("re-clicking does not rewrite the original unsubscribe timestamp", async () => {
    seedSubscriber("both@x.com", ["vendor"]);
    const tok = await signUnsubscribeToken("both@x.com", SECRET, "vendor");
    await click(tok);
    const first = raw
      .prepare(`SELECT unsubscribed_at AS u FROM newsletter_list_subscriptions WHERE list='vendor'`)
      .get() as { u: number };
    await click(tok);
    const second = raw
      .prepare(`SELECT unsubscribed_at AS u FROM newsletter_list_subscriptions WHERE list='vendor'`)
      .get() as { u: number };
    expect(second.u).toBe(first.u);
  });
});
