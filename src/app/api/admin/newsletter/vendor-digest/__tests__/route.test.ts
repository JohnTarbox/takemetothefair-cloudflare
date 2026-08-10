/**
 * OPE-191 §4 — the vendor digest's REFUSAL LADDER.
 *
 * This route can bulk-email a vendor audience, so what it declines to do
 * matters more than what it does. Three independent refusals, each pinned here:
 *
 *   1. no qualifying shows        → send nothing (the §2 "0 rows → skip" rule)
 *   2. VENDOR_DIGEST_SEND_ENABLED → compose + persist only, mail nobody
 *   3. test_recipient             → one address, never the list
 *
 * The persistence assertions matter as much as the send ones: refusal 2's whole
 * value is that a real, reviewable issue still appears at /newsletter/{slug}
 * every Monday while the flag is off. A version that skipped the write would
 * pass a naive "didn't send" test and be useless.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
const enqueueEmailMock = vi.fn(async (_job?: unknown) => {});
const selectEventsMock = vi.fn();
const selectRecipientsMock = vi.fn();
let broadcastEnabled = "false";

const insertedValues: Array<Record<string, unknown>> = [];
const insertMock = vi.fn(() => ({
  values: (v: Record<string, unknown>) => {
    insertedValues.push(v);
    return { onConflictDoUpdate: () => Promise.resolve() };
  },
}));

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({ insert: insertMock }),
  getCloudflareEnv: () => ({
    VENDOR_DIGEST_SEND_ENABLED: broadcastEnabled,
    NEWSLETTER_UNSUBSCRIBE_SECRET: "s3cret",
    MAILING_ADDRESS: "18 Main ST, Phillips, ME 04966",
  }),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: enqueueEmailMock }));
vi.mock("@/lib/newsletter/new-this-week", () => ({
  selectNewThisWeekEvents: () => selectEventsMock(),
}));
vi.mock("@/lib/email/newsletter-broadcast", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    selectBroadcastRecipients: () => selectRecipientsMock(),
    enqueueNewsletterDigest: async (args: { recipients: string[]; source?: string }) => {
      for (const r of args.recipients) await enqueueEmailMock({ to: r, source: args.source });
      return args.recipients.length;
    },
  };
});

const { POST } = await import("../route");

function call(body: Record<string, unknown> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/newsletter/vendor-digest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({}) } as never
  );
}

const SHOW = {
  id: "e1",
  name: "Cummington Fair",
  slug: "cummington-fair",
  startDate: new Date("2026-11-01"),
  endDate: null,
  // string[] by construction — the selection query runs parseJsonArray.
  categories: ["Agricultural Fair"],
  applicationUrl: null,
  sourceUrl: null,
  promoterWebsite: null,
  estimatedAttendance: null,
  eventScale: null,
  indoorOutdoor: null,
  commercialVendorsAllowed: null,
  status: "APPROVED",
};

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  broadcastEnabled = "false";
  authMock.mockResolvedValue({ user: { id: "u1", role: "ADMIN" } });
  selectEventsMock.mockResolvedValue([SHOW]);
  selectRecipientsMock.mockResolvedValue(["vendor@example.com"]);
});

describe("refusal 1 — no qualifying shows", () => {
  it("sends nothing and writes nothing on a quiet week", async () => {
    selectEventsMock.mockResolvedValue([]);
    const res = await call();
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({ success: true, sent: false, reason: "no_new_events" });
    expect(enqueueEmailMock).not.toHaveBeenCalled();
    // No issue row either — an empty digest should leave no trace to review.
    expect(insertedValues).toHaveLength(0);
  });

  it("reports success, not failure — a quiet week is normal", async () => {
    // If this returned an error the cron would log noise (and eventually be
    // ignored) every week nothing new was added.
    selectEventsMock.mockResolvedValue([]);
    expect((await call()).status).toBe(200);
  });
});

describe("refusal 2 — VENDOR_DIGEST_SEND_ENABLED is off", () => {
  it("composes and PERSISTS the issue but mails nobody", async () => {
    const res = await call();
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({ success: true, sent: false, reason: "broadcast_disabled" });
    expect(enqueueEmailMock).not.toHaveBeenCalled();
    // The point of this refusal: a reviewable issue still exists.
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({ sentAt: null });
  });

  it("stamps audience='vendor' so it can never reach the PUBLIC archive (OPE-359)", async () => {
    // Found by mutation: removing the audience stamp failed nothing, and the
    // column defaults to 'weekend' — so a composer that forgot would write a
    // vendor issue as a consumer one and publish it at /newsletter. The default
    // is deliberately the safe direction for OTHER writers; for this one the
    // value must be explicit and asserted.
    await call();
    expect(insertedValues[0]).toMatchObject({ audience: "vendor" });
  });

  it("leaves sent_at NULL, so the archive never claims it was broadcast", async () => {
    // OPE-285's invariant: sent_at means a real broadcast happened.
    await call();
    expect(insertedValues[0].sentAt).toBeNull();
  });

  it("does not even resolve the vendor list while disabled", async () => {
    await call();
    expect(selectRecipientsMock).not.toHaveBeenCalled();
  });

  it("broadcasts once the flag is on", async () => {
    broadcastEnabled = "true";
    const res = await call();
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({ success: true, sent: true, broadcast: true });
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(insertedValues[0].sentAt).toBeInstanceOf(Date);
  });
});

describe("refusal 3 — test_recipient", () => {
  it("sends to the one address and never touches the vendor list", async () => {
    await call({ test_recipient: "me@example.com" });
    expect(selectRecipientsMock).not.toHaveBeenCalled();
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmailMock).toHaveBeenCalledWith({
      to: "me@example.com",
      source: "newsletter:vendor-digest",
    });
  });

  it("a test send does NOT stamp sent_at", async () => {
    await call({ test_recipient: "me@example.com" });
    expect(insertedValues[0].sentAt).toBeNull();
  });

  it("works even with the broadcast flag on — a test is still just a test", async () => {
    broadcastEnabled = "true";
    await call({ test_recipient: "me@example.com" });
    expect(selectRecipientsMock).not.toHaveBeenCalled();
    expect(enqueueEmailMock).toHaveBeenCalledWith({
      to: "me@example.com",
      source: "newsletter:vendor-digest",
    });
  });

  it("ledgers under its OWN source, not the attendee digest's", async () => {
    // Found by checking the ledger after the first real test send: it landed
    // under `newsletter:weekly-digest`, making a vendor send indistinguishable
    // from an attendee one — so "did the vendor digest go out?" was
    // unanswerable from the ledger.
    await call({ test_recipient: "me@example.com" });
    expect(enqueueEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "newsletter:vendor-digest" })
    );
  });
});

describe("dry_run", () => {
  it("reports what would happen and writes nothing", async () => {
    broadcastEnabled = "true";
    const res = await call({ dry_run: true });
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({ dry_run: true, would_broadcast: true, recipient_count: 1 });
    expect(insertedValues).toHaveLength(0);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});
