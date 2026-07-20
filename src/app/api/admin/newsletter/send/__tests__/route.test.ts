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
// Real-send path upserts the issue row before enqueueing — no-op insert chain.
const insertMock = vi.fn(() => ({
  values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
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
    expect(html).toContain("Weekend Fair Digest");
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
