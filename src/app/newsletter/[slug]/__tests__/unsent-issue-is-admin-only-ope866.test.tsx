/**
 * OPE-866 — an unsent newsletter issue is a draft, and drafts are admin-only.
 *
 * The page's only predicate was the slug: no `sent_at` filter, no auth. The
 * composing route notes that a null `sent_at` keeps the issue "out of the
 * public archive" — true of the /newsletter INDEX, and not of the direct URL,
 * which rendered for anyone and carried a canonical tag inviting indexing.
 *
 * Combined with `test_recipient` persisting a row (the other half of this
 * ticket), "send this to me so I can look at it" published a page.
 *
 * ⚠️ Amendment H: "the public gets a 404" is satisfied by a page that 404s for
 * EVERYONE, which would break the feature. So every 404 case here is paired
 * with the admin case on the same fixture, and the sent-issue case proves the
 * page still renders at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let role: string | null = "ADMIN";
let issueRow: Record<string, unknown> | null = null;

vi.mock("@/lib/auth", () => ({ auth: async () => (role ? { user: { role } } : null) }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (issueRow ? [issueRow] : []) }) }),
    }),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/newsletter/newsletter-signup-block", () => ({
  NewsletterSignupBlock: () => null,
}));

const mod = await import("../page");
const Page = mod.default as (p: { params: Promise<{ slug: string }> }) => Promise<unknown>;
const generateMetadata = mod.generateMetadata as (p: {
  params: Promise<{ slug: string }>;
}) => Promise<Record<string, unknown>>;

const render = () => Page({ params: Promise.resolve({ slug: "issue-1" }) });
const meta = () => generateMetadata({ params: Promise.resolve({ slug: "issue-1" }) });

const SENT = {
  slug: "issue-1",
  subject: "This Weekend at the Fair",
  html: "<p>hi</p>",
  sentAt: new Date("2026-09-04T00:00:00Z"),
};
const UNSENT = { ...SENT, sentAt: null };

beforeEach(() => {
  role = "ADMIN";
  issueRow = null;
});

describe("OPE-866 — an unsent issue is not world-readable", () => {
  it("404s for an anonymous reader", async () => {
    issueRow = UNSENT;
    role = null;
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s for a signed-in NON-admin", async () => {
    issueRow = UNSENT;
    role = "VENDOR";
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("RENDERS for an admin — reviewing the draft is why it is persisted", async () => {
    // The other side of the pair. Without this, a page that 404s for everyone
    // would pass both tests above and silently break refusal 2's whole purpose.
    issueRow = UNSENT;
    role = "ADMIN";
    await expect(render()).resolves.toBeTruthy();
  });

  it("a SENT issue still renders for anyone — the feature is intact", async () => {
    issueRow = SENT;
    role = null;
    await expect(render()).resolves.toBeTruthy();
  });

  it("a slug that does not exist 404s, same as before", async () => {
    issueRow = null;
    role = "ADMIN";
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("OPE-866 — an unsent issue is not offered to search engines", () => {
  it("emits noindex and no canonical for an unsent issue", async () => {
    issueRow = UNSENT;
    const m = await meta();
    expect(m.robots).toEqual({ index: false });
    expect(m.alternates).toBeUndefined();
  });

  it("still emits the canonical for a SENT issue", async () => {
    // Landmark: proves the metadata path works at all, so the assertion above
    // is about the sent_at branch and not about metadata being broken.
    issueRow = SENT;
    const m = await meta();
    expect(m.alternates).toEqual({
      canonical: "https://meetmeatthefair.com/newsletter/issue-1",
    });
    expect(m.robots).toBeUndefined();
  });
});
