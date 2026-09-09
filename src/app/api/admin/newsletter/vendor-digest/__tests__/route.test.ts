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

  it("broadcasts once the flag is on AND the send is confirmed", async () => {
    // OPE-862 — this test used to pass with no `require_human_confirmation`,
    // and that is precisely the behaviour that broadcast to three vendor pilots
    // on 2026-09-09. The flag alone is no longer sufficient; the token is the
    // difference between "the mechanism is approved" and "this send is".
    broadcastEnabled = "true";
    const res = await call({ require_human_confirmation: "GO" });
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({ success: true, sent: true, broadcast: true });
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(insertedValues[0].sentAt).toBeInstanceOf(Date);
  });
});

/**
 * OPE-862 — refusal 4.
 *
 * ⚠️ Amendment H note for whoever edits these next. Every assertion here that
 * says "nothing was sent" is one the route can satisfy for the WRONG reason:
 * refusal 1 (`no_new_events`, an empty week) short-circuits before any of this
 * runs and enqueues nothing either. So each case asserts a POSITIVE landmark
 * beside the negative one — `event_count: 1` proves the week was non-empty and
 * the test reached refusal 4 rather than dying at refusal 1. Without that, this
 * whole block passes with the gate deleted AND with the selector broken.
 */
describe("refusal 4 — require_human_confirmation (OPE-862)", () => {
  beforeEach(() => {
    broadcastEnabled = "true";
  });

  it("a NO-ARGUMENT call does not mail the vendor list", async () => {
    const res = await call();
    const json = (await res.json()) as Record<string, unknown>;

    // Negative: nothing went out.
    expect(enqueueEmailMock).not.toHaveBeenCalled();
    // Positive landmarks: the week was non-empty and we reached refusal 4,
    // not refusal 1.
    expect(json).toMatchObject({
      sent: false,
      refused: true,
      reason: "missing_human_confirmation",
      event_count: 1,
    });
  });

  it("names the token in the refusal, so the caller can act on it", async () => {
    const res = await call();
    const json = (await res.json()) as Record<string, string>;
    expect(json.message).toContain('require_human_confirmation: "GO"');
  });

  it("still composes and persists the reviewable issue, unsent", async () => {
    // The refusal degrades to refusal 2 rather than erroring: if the Monday
    // cron is ever restored, an un-tokened run must keep producing the weekly
    // artifact John reviews. Trading an unauthorised send for an invisible
    // newsletter would not be a fix.
    await call();
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].audience).toBe("vendor");
    expect(insertedValues[0].sentAt).toBeNull();
  });

  it("does not even resolve the vendor list without the token", async () => {
    await call();
    expect(selectRecipientsMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a near-miss in the wrong case", "go"],
    ["a plausible-looking substitute", "yes"],
    ["an explicit refusal, which is still a non-empty string", "no"],
    ["a boolean the model might invent", true],
    ["the empty string", ""],
  ])("rejects %s", async (_label, token) => {
    const res = await call({ require_human_confirmation: token });
    const json = (await res.json()) as Record<string, unknown>;

    expect(enqueueEmailMock).not.toHaveBeenCalled();
    expect(json).toMatchObject({ reason: "missing_human_confirmation", event_count: 1 });
  });

  it("keeps the three refusal reasons distinct", async () => {
    // The flag being off and the send being unapproved are different states
    // needing different operator responses. Collapsing them into one string is
    // what left the 09-09 responder unable to tell them apart.
    broadcastEnabled = "false";
    const off = (await (await call()).json()) as Record<string, unknown>;
    expect(off.reason).toBe("broadcast_disabled");

    broadcastEnabled = "true";
    const unapproved = (await (await call()).json()) as Record<string, unknown>;
    expect(unapproved.reason).toBe("missing_human_confirmation");

    selectRecipientsMock.mockResolvedValue([]);
    const empty = (await (await call({ require_human_confirmation: "GO" })).json()) as Record<
      string,
      unknown
    >;
    expect(empty.reason).toBe("no_recipients");
  });

  it("does not gate test_recipient — an unattended test send still works", async () => {
    await call({ test_recipient: "me@example.com" });
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    expect(selectRecipientsMock).not.toHaveBeenCalled();
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
    const res = await call({ dry_run: true, require_human_confirmation: "GO" });
    const json = (await res.json()) as Record<string, unknown>;

    expect(json).toMatchObject({
      dry_run: true,
      would_broadcast: true,
      human_confirmed: true,
      recipient_count: 1,
    });
    expect(insertedValues).toHaveLength(0);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});
