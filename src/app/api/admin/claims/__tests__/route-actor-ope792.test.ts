/**
 * OPE-792 — /api/admin/claims accepts the internal key, and attributes the
 * decision to the right actor.
 *
 * The route was session-only, so the MCP `approve_claim` tool could not call it
 * and re-implemented the transition instead — skipping the claimant
 * notification row and the decision email that only the core writes.
 *
 * The new surface is small but security-relevant, so both halves are pinned:
 * the internal key gets in, and the body's `actorUserId` can NEVER override a
 * real session's own id. Without the second property, an admin could attribute
 * a claim decision to somebody else in `admin_actions`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const approveClaimMock = vi.fn(async () => ({ ok: true as const, entityType: "VENDOR" }));
const rejectClaimMock = vi.fn(async () => ({ ok: true as const, entityType: "VENDOR" }));
let authorized: { authorized: boolean; userId: string | null } = {
  authorized: true,
  userId: null,
};

vi.mock("@/lib/claims/admin-review", () => ({
  approveClaim: (_db: unknown, a: unknown) => approveClaimMock(_db as never, a as never),
  rejectClaim: (_db: unknown, a: unknown) => rejectClaimMock(_db as never, a as never),
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({}),
  getCloudflareEnv: () => ({ INTERNAL_API_KEY: "sekret" }),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));
vi.mock("@/lib/auth", () => ({ auth: async () => null, hasRole: () => false }));

// The single seam `withAuthorized` resolves through.
vi.mock("@/lib/api-auth", () => ({
  getAuthorizedSession: async () => authorized,
  internalKeyMatches: async () => authorized.userId === null && authorized.authorized,
}));

const { POST } = await import("../route");

const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );

beforeEach(() => {
  approveClaimMock.mockClear();
  rejectClaimMock.mockClear();
  authorized = { authorized: true, userId: null };
});

describe("POST /api/admin/claims — actor attribution (OPE-792)", () => {
  it("uses the body's actorUserId on the internal-key path, which has no session", async () => {
    authorized = { authorized: true, userId: null };
    const res = await call({ claimId: "c-1", action: "approve", actorUserId: "u-agent" });
    expect(res.status).toBe(200);
    expect(approveClaimMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimId: "c-1", actorUserId: "u-agent" })
    );
  });

  it("a SESSION's id always wins — the body can never re-attribute a decision", async () => {
    authorized = { authorized: true, userId: "u-real-admin" };
    await call({ claimId: "c-1", action: "approve", actorUserId: "u-someone-else" });
    expect(approveClaimMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: "u-real-admin" })
    );
  });

  it('falls back to "internal" rather than writing an empty actor', async () => {
    authorized = { authorized: true, userId: null };
    await call({ claimId: "c-1", action: "approve" });
    expect(approveClaimMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: "internal" })
    );
  });

  it("still refuses a rejection with no reason", async () => {
    await call({ claimId: "c-1", action: "reject" }).then(async (r) => {
      expect(r.status).toBe(400);
    });
    expect(rejectClaimMock).not.toHaveBeenCalled();
  });

  it("401s when not authorized at all", async () => {
    authorized = { authorized: false, userId: null };
    const res = await call({ claimId: "c-1", action: "approve" });
    expect(res.status).toBe(401);
    expect(approveClaimMock).not.toHaveBeenCalled();
  });
});
