/**
 * OPE-169 — /api/admin/newsletter/send guard rails (run before any DB access):
 * admin-only, required fields, and the NEWSLETTER_SEND_ENABLED broadcast gate
 * (a real broadcast is 409 when the flag is off; a single-address test_recipient
 * send is exempt). Nothing is enqueued in any refuse case. The recipient
 * selection + per-recipient render/enqueue are exercised by the digest-template
 * and unsubscribe-token unit tests.
 *
 * OPE-190 — adds `preview_only`: a read-only pre-flight that resolves the
 * recipient list with zero side effects (no enqueue) and is exempt from the
 * broadcast flag. Auth moved to withAuthorized (admin session OR X-Internal-Key)
 * so the MCP `send_newsletter_broadcast` tool can forward server-to-server; the
 * session path still authorizes via the mocked auth() below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
// OPE-232 — capture the enqueued job so the send-route test can assert on the
// ACTUAL rendered HTML (footer + view-in-browser + env-sourced address), not the
// template in isolation. The env-sourced address is the gap the isolated
// template tests could never catch.
const enqueueEmailMock = vi.fn(async (_job?: unknown) => {});
const selectMock = vi.fn();
let sendEnabled = "false";
let mailingAddress: string | undefined = "18 Main ST, Phillips, ME 04966";
// Real-send path upserts the issue row before enqueueing. The chain CAPTURES
// its arguments rather than discarding them: OPE-285 turns on what this upsert
// writes to `sent_at`, and a mock that swallows the values can't see it.
const insertedValues: Array<Record<string, unknown>> = [];
const conflictSets: Array<Record<string, unknown>> = [];
const insertMock = vi.fn(() => ({
  values: (v: Record<string, unknown>) => {
    insertedValues.push(v);
    return {
      onConflictDoUpdate: (cfg: { set?: Record<string, unknown> }) => {
        conflictSets.push(cfg?.set ?? {});
        return Promise.resolve();
      },
    };
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: () => authMock(),
  hasRole: (s: { user?: { role?: string } } | null, r: string) => s?.user?.role === r,
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({ select: selectMock, insert: insertMock })),
  getCloudflareEnv: vi.fn(() => ({
    NEWSLETTER_SEND_ENABLED: sendEnabled,
    AUTH_SECRET: "s",
    MAILING_ADDRESS: mailingAddress,
  })),
}));
vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: (job: unknown) => enqueueEmailMock(job),
}));

import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/newsletter/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
// withAuthorized returns a handler whose ctx (params) is typed as required; Next
// supplies it at runtime — for static routes params resolves to {}.
const ctx = { params: Promise.resolve({}) };
const call = (body: unknown) => POST(req(body), ctx);
const admin = () => authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });

beforeEach(() => {
  authMock.mockReset();
  enqueueEmailMock.mockClear();
  selectMock.mockReset();
  insertMock.mockClear();
  insertedValues.length = 0;
  conflictSets.length = 0;
  sendEnabled = "false";
  mailingAddress = "18 Main ST, Phillips, ME 04966";
});

describe("POST /api/admin/newsletter/send — guard rails (OPE-169)", () => {
  it("401 for a non-admin", async () => {
    authMock.mockResolvedValue(null);
    const res = await call({ subject: "Hi", content_html: "<p>x</p>" });
    expect(res.status).toBe(401);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("400 when subject or content_html is missing", async () => {
    admin();
    const res = await call({ subject: "", content_html: "" });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("missing_fields");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("409 for a broadcast when NEWSLETTER_SEND_ENABLED is off; nothing enqueued", async () => {
    admin();
    sendEnabled = "false";
    const res = await call({ subject: "Weekend digest", content_html: "<p>hi</p>" });
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("broadcast_disabled");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/newsletter/send — preview_only (OPE-190)", () => {
  it("returns the resolved recipient list read-only (no enqueue), exempt from the broadcast flag", async () => {
    admin();
    sendEnabled = "false"; // preview must NOT be blocked by the flag
    // First select → confirmed subscribers; second select → suppression list.
    selectMock
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ email: "a@x.com" }, { email: "b@x.com" }]),
        }),
      })
      .mockReturnValueOnce({ from: () => Promise.resolve([{ email: "b@x.com" }]) });

    const res = await call({
      subject: "Weekend digest",
      content_html: "<p>hi</p>",
      preview_only: true,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      preview: boolean;
      mode: string;
      recipient_count: number;
      recipients: string[];
    };
    expect(j.preview).toBe(true);
    expect(j.mode).toBe("broadcast");
    // b@x.com is suppressed → only a@x.com survives.
    expect(j.recipient_count).toBe(1);
    expect(j.recipients).toEqual(["a@x.com"]);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("previews a test send (single recipient) without touching the subscriber tables", async () => {
    admin();
    const res = await call({
      subject: "Weekend digest",
      content_html: "<p>hi</p>",
      preview_only: true,
      test_recipient: "me@x.com",
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { preview: boolean; mode: string; recipient_count: number };
    expect(j.preview).toBe(true);
    expect(j.mode).toBe("test");
    expect(j.recipient_count).toBe(1);
    // test_recipient short-circuits recipient resolution — no D1 select at all.
    expect(selectMock).not.toHaveBeenCalled();
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});

// OPE-232 — assert on the ACTUAL enqueued HTML, not the template in isolation.
// This is the send-route integration test the reopened ticket asked for: the
// isolated template tests passed while the real send dropped the env-sourced
// mailing address (MAILING_ADDRESS was only set on the MCP worker, not the
// main-app worker that renders). This catches that whole class.
describe("POST /api/admin/newsletter/send — rendered HTML on a real test send (OPE-232)", () => {
  const sendTest = () =>
    call({ subject: "Weekend digest", content_html: "<p>hi</p>", test_recipient: "me@x.com" });
  const enqueuedHtml = () =>
    (enqueueEmailMock.mock.calls[0]?.[0] as { html: string } | undefined)?.html ?? "";

  it("enqueues one job with the branded footer, view-in-browser, unsubscribe, and env MAILING_ADDRESS", async () => {
    admin();
    const res = await sendTest();
    expect(res.status).toBe(200);
    expect(enqueueEmailMock).toHaveBeenCalledTimes(1);
    const html = enqueuedHtml();
    // Gap 2 — view-in-browser link present + clickable.
    expect(html).toContain("View this email in your browser");
    // Per-recipient unsubscribe link present.
    expect(html).toContain("/api/newsletter/unsubscribe?token=");
    // Gap 1 — branded newsletter footer. NOTE: asserting "Weekend Fair Digest"
    // here (as this test originally did) only proves the MASTHEAD shipped —
    // it matched while the footer was still flat text on cream, which is how
    // the 2026-07-20 ship read as verified and was reopened hours later. The
    // footer is a distinct GREEN BAND, so assert the second band and that the
    // CAN-SPAM set lives inside it.
    expect(html).toContain("This Weekend at the Fair");
    expect(html.split("background:#1f3a2d").length - 1).toBe(2);
    const footer = html.slice(html.lastIndexOf("background:#1f3a2d"));
    expect(footer).toContain("/api/newsletter/unsubscribe?token=");
    expect(footer).toContain("View this email in your browser");
    // Gap 3 — the ENV-sourced postal address renders, NOT the hardcoded fallback.
    expect(html).toContain("18 Main ST, Phillips, ME 04966");
    expect(html).not.toContain("Meet Me at the Fair, New England");
  });

  it("GUARD: when MAILING_ADDRESS is unset, the CAN-SPAM fallback is visible (the shipped bug)", async () => {
    admin();
    mailingAddress = undefined; // reproduce the main-app-worker-missing-binding state
    await sendTest();
    // This asserts the exact regression: no env → the generic placeholder. If a
    // future change makes the env read work, THIS test flips and must be updated —
    // which is the signal that the address wiring changed.
    expect(enqueuedHtml()).toContain("Meet Me at the Fair, New England");
  });
});

// OPE-284 — the approve CTA must honour NEWSLETTER_SEND_ENABLED at COMPOSE time,
// not only when the link is clicked. Before this, a preview composed with the gate
// off still rendered a live "Approve & send to everyone" button, and clicking it
// landed on "Sending is turned off" (John, 2026-07-23). The email must never offer
// an action the system will refuse.
describe("POST /api/admin/newsletter/send — approve CTA checks the gate at compose time (OPE-284)", () => {
  const sendPreview = () =>
    call({ subject: "Weekend digest", content_html: "<p>hi</p>", test_recipient: "me@x.com" });
  const enqueuedHtml = () =>
    (enqueueEmailMock.mock.calls[0]?.[0] as { html: string } | undefined)?.html ?? "";

  it("gate OFF → renders the disabled explanation and NO approve link", async () => {
    admin();
    sendEnabled = "false";
    const res = await sendPreview();
    expect(res.status).toBe(200);
    const html = enqueuedHtml();
    expect(html).toContain("Broadcast sending is currently disabled");
    // The unkeepable promise must be gone — both the label and the live token URL.
    expect(html).not.toContain("Approve &amp; send to everyone");
    expect(html).not.toContain("/newsletter/approve?token=");
  });

  it("gate ON → renders the live approve button and no disabled copy", async () => {
    admin();
    sendEnabled = "true";
    const res = await sendPreview();
    expect(res.status).toBe(200);
    const html = enqueuedHtml();
    expect(html).toContain("Approve &amp; send to everyone");
    expect(html).toContain("/newsletter/approve?token=");
    expect(html).not.toContain("Broadcast sending is currently disabled");
  });

  it("SAFETY: a real broadcast carries neither the approve button nor the disabled banner", async () => {
    admin();
    sendEnabled = "true";
    selectMock
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ email: "sub@x.com" }]) }),
      })
      .mockReturnValueOnce({ from: () => Promise.resolve([]) });
    const res = await call({ subject: "Weekend digest", content_html: "<p>hi</p>" });
    expect(res.status).toBe(200);
    const html = enqueuedHtml();
    expect(html).not.toContain("Approve &amp; send to everyone");
    expect(html).not.toContain("Broadcast sending is currently disabled");
  });
});

/**
 * OPE-285 — `sent_at` is what puts an issue on the PUBLIC archive.
 *
 * The rule is one line in the route (`sentAt: isBroadcast ? now : null`) and it
 * was, until now, entirely unpinned. That matters more than it looks: a preview
 * that stamped `sent_at` would publish an unsent draft to /newsletter, and — the
 * inverse — a reviewer looking at a stamped row cannot tell whether it was a
 * real send or a leaked preview. That exact ambiguity cost a day of argument
 * over the 2026-07-16 row, which the ledger ultimately proved was a genuine
 * broadcast to six confirmed subscribers.
 *
 * So both directions are pinned, on both the insert and the on-conflict path.
 */
describe("sent_at is set ONLY by a real broadcast (OPE-285)", () => {
  it("a test_recipient preview writes sent_at = null", async () => {
    admin();
    sendEnabled = "true"; // flag ON, so this can only be the test path deciding
    await call({
      subject: "This Weekend at the Fair — preview",
      content_html: "<p>hi</p>",
      test_recipient: "me@x.com",
    });
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].sentAt).toBeNull();
  });

  it("a preview must not stamp sent_at when UPSERTING over an existing row", async () => {
    // The subtler leak: re-previewing an issue whose slug already exists must
    // leave any existing sent_at alone, so the on-conflict set must omit it.
    admin();
    sendEnabled = "true";
    await call({
      subject: "This Weekend at the Fair — preview",
      content_html: "<p>hi</p>",
      test_recipient: "me@x.com",
    });
    expect(conflictSets).toHaveLength(1);
    expect(conflictSets[0]).not.toHaveProperty("sentAt");
  });

  it("a real broadcast DOES stamp sent_at, on both insert and conflict", async () => {
    admin();
    sendEnabled = "true";
    selectMock
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ email: "sub@x.com" }]) }),
      })
      .mockReturnValueOnce({ from: () => Promise.resolve([]) });
    const res = await call({
      subject: "This Weekend at the Fair — Jul 31",
      content_html: "<p>hi</p>",
    });
    expect(res.status).toBe(200);
    expect(insertedValues[0].sentAt).toBeInstanceOf(Date);
    expect(conflictSets[0]).toHaveProperty("sentAt");
  });

  it("a preview_only pre-flight writes NOTHING at all", async () => {
    // Read-only by contract — it must not upsert an issue row, which would put
    // a slug on the archive path before anyone approved anything.
    admin();
    sendEnabled = "true";
    selectMock
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ email: "sub@x.com" }]) }),
      })
      .mockReturnValueOnce({ from: () => Promise.resolve([]) });
    await call({
      subject: "This Weekend at the Fair — dry run",
      content_html: "<p>hi</p>",
      preview_only: true,
    });
    expect(insertMock).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
  });
});
