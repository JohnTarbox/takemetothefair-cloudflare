/**
 * OPE-163 — /api/admin/inbound-emails/[id]/reply guard rails. Covers the
 * endpoint-specific gates that run before any DB access: admin-only, the
 * EMAIL_REPLY_ENABLED flag (409 when off), and body validation. In every
 * refuse case nothing is enqueued. The DB-dependent reply logic (subject/html/
 * threading/suppression/status) is shared with — and covered by — the
 * handleReplyToInbound unit tests in mcp-server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();
const enqueueEmailMock = vi.fn(async () => {});
let replyEnabled = "false";

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({})),
  getCloudflareEnv: vi.fn(() => ({ EMAIL_REPLY_ENABLED: replyEnabled })),
}));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail: () => enqueueEmailMock() }));

import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/inbound-emails/inb-1/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ id: "inb-1" });

beforeEach(() => {
  authMock.mockReset();
  enqueueEmailMock.mockClear();
  replyEnabled = "false";
});

describe("POST /api/admin/inbound-emails/[id]/reply — guard rails (OPE-163)", () => {
  it("401 for a non-admin; nothing enqueued", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req({ body: "hi" }), { params });
    expect(res.status).toBe(401);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("409 when replies are disabled (flag off); nothing enqueued", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    replyEnabled = "false";
    const res = await POST(req({ body: "hi" }), { params });
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("reply_disabled");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("400 when enabled but body is empty; nothing enqueued", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    replyEnabled = "true";
    const res = await POST(req({ body: "   " }), { params });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("missing_body");
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });
});
