/**
 * OPE-1107 — the token a broadcast CARRIES names the list the broadcast came
 * from, and clicking it removes exactly that list.
 *
 * OPE-864 pinned both ends separately: the signer can express a list, and the
 * handler honours it. Neither end was wrong. The defect was between them — the
 * rail derived the list from the ledger `source`, and three of the four vendor
 * send paths never passed the one source string that meant "vendor". The first
 * real vendor broadcast (2026-09-21) went out carrying
 * `john@pimboat.com|weekend` to a vendor-only subscriber.
 *
 * So these tests take the token out of the ENQUEUED message — the thing that
 * would reach an inbox — and click it against the real handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { verifyUnsubscribeToken } from "../newsletter-unsubscribe-token";

const SECRET = "test-secret-value-for-hmac";
const enqueued: Record<string, unknown>[] = [];

vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: vi.fn(async (args: Record<string, unknown>) => {
    enqueued.push(args);
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({ NEWSLETTER_UNSUBSCRIBE_SECRET: SECRET }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("@/lib/email/send", () => ({ getSiteUrl: () => "https://meetmeatthefair.com" }));

const { enqueueNewsletterDigest, NEWSLETTER_SOURCE, VENDOR_DIGEST_SOURCE } =
  await import("../newsletter-broadcast");
const { GET } = await import("@/app/api/newsletter/unsubscribe/route");

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

const BASE = {
  subject: "Shows Now Open for Vendors — Week of Sep 21, 2026",
  contentHtml: "<p>hi</p>",
  siteUrl: "https://meetmeatthefair.com",
  secret: SECRET,
  viewInBrowserUrl: "https://meetmeatthefair.com/newsletter/x",
};

const tokenOf = (msg: Record<string, unknown>) =>
  String(msg.listUnsubscribe).match(/token=([^>]+)>/)![1];

function seed(email: string, lists: string[]) {
  raw
    .prepare(
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, created_at)
       VALUES ('sub1', ?, 1, 0, 0)`
    )
    .run(email);
  for (const l of lists)
    raw
      .prepare(
        `INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at)
         VALUES (?, 'sub1', ?, 0)`
      )
      .run(`row-${l}`, l);
}

const isLive = (list: string) => {
  const r = raw
    .prepare(`SELECT unsubscribed_at AS u FROM newsletter_list_subscriptions WHERE list = ?`)
    .get(list) as { u: number | null } | undefined;
  return !!r && r.u === null;
};

beforeEach(() => {
  enqueued.length = 0;
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the token a send carries names the list the send belongs to", () => {
  // Every shape a vendor send takes in the code today, including the three that
  // produced `|weekend`: approve and send pass no source; the test send passes
  // a suffixed one.
  const vendorShapes: Array<[string, Record<string, unknown>]> = [
    ["approve / send route — no source passed", {}],
    ["vendor-digest test send — suffixed source", { source: `${VENDOR_DIGEST_SOURCE}:test` }],
    ["vendor-digest broadcast — exact source", { source: VENDOR_DIGEST_SOURCE }],
  ];

  for (const [label, extra] of vendorShapes) {
    it(`vendor issue → <email>|vendor (${label})`, async () => {
      await enqueueNewsletterDigest({
        ...BASE,
        ...extra,
        audience: "vendor",
        recipients: ["john@pimboat.com"],
      });
      const claims = await verifyUnsubscribeToken(tokenOf(enqueued[0]), SECRET);
      expect(claims).toEqual({ email: "john@pimboat.com", list: "vendor" });
    });
  }

  it("weekend issue → <email>|weekend (the converse, ask 4)", async () => {
    await enqueueNewsletterDigest({ ...BASE, audience: "weekend", recipients: ["a@x.com"] });
    expect(await verifyUnsubscribeToken(tokenOf(enqueued[0]), SECRET)).toEqual({
      email: "a@x.com",
      list: "weekend",
    });
  });

  it("the ledger source follows the audience when the caller gives none", async () => {
    await enqueueNewsletterDigest({ ...BASE, audience: "vendor", recipients: ["v@x.com"] });
    await enqueueNewsletterDigest({ ...BASE, audience: "weekend", recipients: ["w@x.com"] });
    expect(enqueued.map((m) => m.source)).toEqual([VENDOR_DIGEST_SOURCE, NEWSLETTER_SOURCE]);
  });
});

describe("ACCEPTANCE — the enqueued vendor token, clicked, removes exactly the vendor list", () => {
  it("a vendor-only subscriber (the specimen) is actually unsubscribed", async () => {
    seed("john@pimboat.com", ["vendor"]);
    expect(isLive("vendor")).toBe(true); // landmark

    await enqueueNewsletterDigest({
      ...BASE,
      audience: "vendor",
      recipients: ["john@pimboat.com"],
    });
    await GET(
      new Request(
        `https://meetmeatthefair.com/api/newsletter/unsubscribe?token=${tokenOf(enqueued[0])}`
      ) as never
    );

    expect(isLive("vendor")).toBe(false);
  });

  it("a subscriber on BOTH lists keeps the weekend digest", async () => {
    seed("both@x.com", ["weekend", "vendor"]);
    expect(isLive("weekend") && isLive("vendor")).toBe(true); // landmark

    await enqueueNewsletterDigest({ ...BASE, audience: "vendor", recipients: ["both@x.com"] });
    await GET(
      new Request(
        `https://meetmeatthefair.com/api/newsletter/unsubscribe?token=${tokenOf(enqueued[0])}`
      ) as never
    );

    expect(isLive("vendor")).toBe(false);
    expect(isLive("weekend")).toBe(true);
  });
});
