/**
 * OPE-178 — /api/admin/inbound-emails/[id]/log-external-reply guard rails:
 * admin-only, and recipient + body required. It's log-only, so it must never
 * call any send path (there is none imported); these pin the early gates that
 * run before DB access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: vi.fn(() => ({})) }));

import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/inbound-emails/inb-1/log-external-reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ id: "inb-1" });

beforeEach(() => authMock.mockReset());

describe("POST …/log-external-reply — guard rails (OPE-178)", () => {
  it("401 for a non-admin", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req({ recipient: "a@b.com", body: "hi" }), { params });
    expect(res.status).toBe(401);
  });

  it("400 when recipient or body is missing", async () => {
    authMock.mockResolvedValue({ user: { role: "ADMIN", id: "a1" } });
    const res = await POST(req({ recipient: "", body: "" }), { params });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("missing_fields");
  });
});
