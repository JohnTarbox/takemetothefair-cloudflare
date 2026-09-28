/**
 * OPE-1204 — the approve INTERSTITIAL counts the issue's own audience.
 *
 * On 2026-09-28 a vendor issue's confirm screen read "Approve & send to 75
 * subscribers": the weekend list's size, because the page hard-coded
 * `selectBroadcastRecipients(db, "weekend")`. The POST behind it already sent to
 * the issue's audience (OPE-795), so the number John was asked to approve and the
 * number that would have been mailed disagreed.
 *
 * These render the page itself, not the resolver behind it: the defect lived in
 * the page, and a green resolver test says nothing about what the page shows.
 * Real SQLite for the reason `route.audience.test.ts` gives — a mock returns
 * whatever list you hand it, whichever audience was asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/lib/db/schema";
import { signApproveToken } from "@/lib/email/newsletter-approve-token";
import { resolveApprovePreview } from "@/lib/email/newsletter-approve-preview";

const SECRET = "approve-secret";

// `audience` is nullable here (prod has NOT NULL DEFAULT 'weekend') so the NULL
// refusal can be exercised; the resolver must refuse it rather than default.
const SCHEMA_SQL = `
  CREATE TABLE newsletter_subscribers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 0, unsubscribed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER, confirmed_at INTEGER, unsubscribed_at INTEGER,
    confirmation_token_hash TEXT, confirmation_expires INTEGER
  );
  CREATE TABLE newsletter_list_subscriptions (
    id TEXT PRIMARY KEY, subscriber_id TEXT NOT NULL, list TEXT NOT NULL,
    created_at INTEGER NOT NULL, unsubscribed_at INTEGER, UNIQUE (subscriber_id, list)
  );
  CREATE TABLE email_suppression_list (email TEXT PRIMARY KEY, reason TEXT, created_at INTEGER);
  CREATE TABLE newsletter_issues (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, subject TEXT NOT NULL, html TEXT NOT NULL,
    sent_at INTEGER, audience TEXT, created_at INTEGER
  );
`;

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({ NEWSLETTER_SEND_ENABLED: "true", AUTH_SECRET: SECRET }),
}));

const { default: NewsletterApprovePage } = await import("../page");

// The 2026-09-28 shape: 4 vendor subscribers, 2 of whom are also on the weekend
// list, and a weekend list far larger than the vendor one.
const VENDOR_ONLY = ["vo0@example.com", "vo1@example.com"];
const BOTH = ["both0@example.com", "both1@example.com"];
const WEEKEND_ONLY = Array.from({ length: 73 }, (_, i) => `w${i}@example.com`);

function seedSubscriber(email: string, lists: string[]) {
  raw
    .prepare(
      `INSERT INTO newsletter_subscribers (id,email,confirmed,unsubscribed) VALUES (?,?,1,0)`
    )
    .run(email, email);
  for (const list of lists) {
    raw
      .prepare(
        `INSERT INTO newsletter_list_subscriptions (id,subscriber_id,list,created_at) VALUES (?,?,?,0)`
      )
      .run(`${email}-${list}`, email, list);
  }
}

function seedIssue(slug: string, audience: string | null) {
  raw
    .prepare(
      `INSERT INTO newsletter_issues (id,slug,subject,html,sent_at,audience,created_at) VALUES (?,?,?,?,NULL,?,0)`
    )
    .run(slug, slug, "Shows Now Open for Vendors", "<p>body</p>", audience);
}

async function renderFor(slug: string): Promise<string> {
  const token = await signApproveToken(slug, SECRET, new Date());
  const el = await NewsletterApprovePage({ searchParams: Promise.resolve({ token }) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  for (const e of VENDOR_ONLY) seedSubscriber(e, ["vendor"]);
  for (const e of BOTH) seedSubscriber(e, ["vendor", "weekend"]);
  for (const e of WEEKEND_ONLY) seedSubscriber(e, ["weekend"]);
});

describe("/newsletter/approve interstitial — counts the issue's own list (OPE-1204)", () => {
  it("a vendor issue offers the 4 vendor subscribers, never the 75 weekend ones", async () => {
    seedIssue("vendor-2026-09-28", "vendor");
    const html = await renderFor("vendor-2026-09-28");
    expect(html).toContain("Approve &amp; send to 4 subscribers (vendor)");
    expect(html).toContain("4 subscribers on the vendor list");
    expect(html).toContain("New This Week");
    // The defect as observed, stated as the assertion.
    expect(html).not.toMatch(/\b75 subscribers\b/);
  });

  it("the count shown is the address set the POST would send to", async () => {
    // Same resolver the page uses; asserted on addresses, not just a count, so a
    // wrong list of the right size cannot pass.
    seedIssue("vendor-2026-09-28", "vendor");
    const preview = await resolveApprovePreview(db as never, "vendor-2026-09-28");
    expect(preview).toMatchObject({ kind: "ready", audience: "vendor", recipientCount: 4 });
    const { selectBroadcastRecipients } = await import("@/lib/email/newsletter-broadcast");
    const to = (await selectBroadcastRecipients(db as never, "vendor")).sort();
    expect(to).toEqual([...VENDOR_ONLY, ...BOTH].sort());
  });

  it("a weekend issue still offers the 75 weekend subscribers (no regression)", async () => {
    seedIssue("weekend-2026-09-28", "weekend");
    const html = await renderFor("weekend-2026-09-28");
    expect(html).toContain("Approve &amp; send to 75 subscribers (weekend)");
    expect(html).toContain("This Weekend at the Fair");
  });

  it.each([
    ["an unrecognised audience", "subscribers-of-some-kind"],
    ["a NULL audience", null],
  ])("%s renders a refusal with no send button", async (_label, audience) => {
    seedIssue("mystery-2026-09-28", audience);
    const html = await renderFor("mystery-2026-09-28");
    expect(html).toContain("This issue has no mailing list");
    expect(html).not.toContain('action="/api/newsletter/approve"');
    expect(html).not.toContain("Approve &amp; send");
  });
});
