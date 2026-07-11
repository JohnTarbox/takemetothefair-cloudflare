/**
 * OPE-169 — /api/admin/newsletter/send guard rails (run before any DB access):
 * admin-only, required fields, and the NEWSLETTER_SEND_ENABLED broadcast gate
 * (a real broadcast is 409 when the flag is off; a single-address test_recipient
 * send is exempt). Nothing is enqueued in any refuse case. The recipient
 * selection + per-recipient render/enqueue are exercised by the digest-template
 * and unsubscribe-token unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
const enqueueEmailMock = vi.fn(async () => {});
let sendEnabled = "false";

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({})),
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
const admin = () => authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });

beforeEach(() => {
  authMock.mockReset();
  enqueueEmailMock.mockClear();
  sendEnabled = "false";
});

describe("POST /api/admin/newsletter/send — guard rails (OPE-169)", () => {
  it("401 for a non-admin", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req({ subject: "Hi", content_html: "<p>x</p>" }));
    expect(res.status).toBe(401);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("400 when subject or content_html is missing", async () => {
    admin();
    const res = await POST(req({ subject: "", content_html: "" }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("missing_fields");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("409 for a broadcast when NEWSLETTER_SEND_ENABLED is off; nothing enqueued", async () => {
    admin();
    sendEnabled = "false";
    const res = await POST(req({ subject: "Weekend digest", content_html: "<p>hi</p>" }));
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("broadcast_disabled");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});
