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
const enqueueEmailMock = vi.fn(async () => {});
const selectMock = vi.fn();
let sendEnabled = "false";

vi.mock("@/lib/auth", () => ({
  auth: () => authMock(),
  hasRole: (s: { user?: { role?: string } } | null, r: string) => s?.user?.role === r,
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({ select: selectMock })),
  getCloudflareEnv: vi.fn(() => ({ NEWSLETTER_SEND_ENABLED: sendEnabled, AUTH_SECRET: "s" })),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: () => enqueueEmailMock() }));

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
  sendEnabled = "false";
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
