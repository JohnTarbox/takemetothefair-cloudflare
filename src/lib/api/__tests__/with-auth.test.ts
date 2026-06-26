/**
 * Tests for the withAuth() route wrapper. This is the payoff of the wrapper:
 * the auth gate, db wiring, and 500-funnel are verified ONCE here, so routes
 * built on withAuth() only need to test their own unique body.
 *
 * `auth()`, `getCloudflareDb()`, and `logError()` are mocked at the module
 * level — same approach as src/lib/__tests__/require-verified-session.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

const ctl = vi.hoisted(() => ({
  session: null as Session | null,
  logError: vi.fn(async (..._args: unknown[]) => {}),
  db: { marker: "db" },
  internalKeyOk: false,
  vendorAuth: { authorized: false, error: "Invalid token" } as
    | { authorized: true; vendorId: string }
    | { authorized: false; error: string },
  authorized: { authorized: false } as { authorized: boolean; userId?: string },
  getAuthorizedSessionSpy: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ctl.session),
  // Mirror the real hasRole: reads the roles[] array, false when unauthenticated.
  hasRole: (session: Session | null, role: string) =>
    !!session?.user?.roles?.includes(role as Session["user"]["roles"][number]),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: vi.fn(() => ctl.db) }));
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => ctl.logError(...args) }));
vi.mock("@/lib/api-auth", () => ({
  internalKeyMatches: vi.fn(async () => ctl.internalKeyOk),
  getAuthorizedSession: (...args: unknown[]) => {
    ctl.getAuthorizedSessionSpy(...args);
    return Promise.resolve(ctl.authorized);
  },
}));
vi.mock("@/lib/api-token-auth", () => ({
  authenticateVendorToken: vi.fn(async () => ctl.vendorAuth),
}));

import { withApiToken, withAuth, withAuthorized, withInternalKey } from "@/lib/api/with-auth";

const adminSession = {
  user: { id: "u1", email: "a@b.c", role: "ADMIN", roles: ["ADMIN"] },
} as unknown as Session;

const req = (url = "https://x.test/api/admin/thing") => new NextRequest(url, { method: "GET" });
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  ctl.session = null;
  ctl.internalKeyOk = false;
  ctl.vendorAuth = { authorized: false, error: "Invalid token" };
  ctl.authorized = { authorized: false };
  ctl.logError.mockClear();
  ctl.getAuthorizedSessionSpy.mockClear();
});

describe("withAuth", () => {
  it("returns 401 when unauthenticated", async () => {
    const handler = vi.fn();
    const GET = withAuth({ role: "ADMIN" }, handler);
    const res = await GET(req(), ctx({}));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 when authenticated but lacking the required role", async () => {
    ctl.session = { user: { id: "u2", roles: ["VENDOR"] } } as unknown as Session;
    const handler = vi.fn();
    const GET = withAuth({ role: "ADMIN" }, handler);
    const res = await GET(req(), ctx({}));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler with db + session + awaited params on success", async () => {
    ctl.session = adminSession;
    const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, session, params }) => {
      expect(db).toBe(ctl.db);
      expect(session).toBe(adminSession);
      expect(params).toEqual({ id: "42" }); // proves the Promise was awaited
      return Response.json({ ok: true });
    });
    const res = await GET(req(), ctx({ id: "42" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("funnels a thrown error to 500 and logs it", async () => {
    ctl.session = adminSession;
    const GET = withAuth({ role: "ADMIN" }, async () => {
      throw new Error("boom");
    });
    const res = await GET(req(), ctx({}));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal server error" });
    expect(ctl.logError).toHaveBeenCalledOnce();
  });

  it("allows any signed-in user when no role is required", async () => {
    ctl.session = { user: { id: "u3", roles: ["USER"] } } as unknown as Session;
    const GET = withAuth(async ({ session }) => Response.json({ id: session.user.id }));
    const res = await GET(req(), ctx({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "u3" });
  });
});

describe("withInternalKey", () => {
  it("returns 401 when the internal key does not match", async () => {
    const handler = vi.fn();
    const POST = withInternalKey(handler);
    const res = await POST(req(), ctx({}));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler with db + params when the key matches (no session)", async () => {
    ctl.internalKeyOk = true;
    const POST = withInternalKey<{ id: string }>(async ({ db, params }) => {
      expect(db).toBe(ctl.db);
      expect(params).toEqual({ id: "9" });
      return Response.json({ ok: true });
    });
    const res = await POST(req(), ctx({ id: "9" }));
    expect(res.status).toBe(200);
  });

  it("funnels a thrown error to 500 and logs it", async () => {
    ctl.internalKeyOk = true;
    const POST = withInternalKey(async () => {
      throw new Error("boom");
    });
    const res = await POST(req(), ctx({}));
    expect(res.status).toBe(500);
    expect(ctl.logError).toHaveBeenCalledOnce();
  });
});

describe("withApiToken", () => {
  it("returns 401 with the helper's error when the token is rejected", async () => {
    ctl.vendorAuth = { authorized: false, error: "Token does not match this vendor" };
    const handler = vi.fn();
    const GET = withApiToken<{ slug: string }>({}, handler);
    const res = await GET(req(), ctx({ slug: "acme" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Token does not match this vendor" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler with the resolved vendorId on success", async () => {
    ctl.vendorAuth = { authorized: true, vendorId: "v-123" };
    const GET = withApiToken<{ slug: string }>({}, async ({ db, vendorId, params }) => {
      expect(db).toBe(ctl.db);
      expect(vendorId).toBe("v-123");
      expect(params).toEqual({ slug: "acme" });
      return Response.json({ vendorId });
    });
    const res = await GET(req(), ctx({ slug: "acme" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ vendorId: "v-123" });
  });
});

describe("withAuthorized", () => {
  it("returns 401 when not authorized", async () => {
    const handler = vi.fn();
    const POST = withAuthorized(handler);
    const res = await POST(req(), ctx({}));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("exposes the user id for an admin session", async () => {
    ctl.authorized = { authorized: true, userId: "admin-7" };
    const POST = withAuthorized(async ({ db, userId }) => {
      expect(db).toBe(ctl.db);
      return Response.json({ userId });
    });
    const res = await POST(req(), ctx({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ userId: "admin-7" });
  });

  it("exposes userId=null for X-Internal-Key (no session user)", async () => {
    ctl.authorized = { authorized: true }; // internal-key: authorized, no userId
    const POST = withAuthorized(async ({ userId }) => Response.json({ userId }));
    const res = await POST(req(), ctx({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ userId: null });
  });

  it("funnels a thrown error to 500 and logs it", async () => {
    ctl.authorized = { authorized: true, userId: "admin-7" };
    const POST = withAuthorized(async () => {
      throw new Error("boom");
    });
    const res = await POST(req(), ctx({}));
    expect(res.status).toBe(500);
    expect(ctl.logError).toHaveBeenCalledOnce();
  });

  it("forwards allowReadonlyBearer:false to getAuthorizedSession", async () => {
    ctl.authorized = { authorized: true, userId: "admin-7" };
    const GET = withAuthorized({ allowReadonlyBearer: false }, async () =>
      Response.json({ ok: 1 })
    );
    await GET(req(), ctx({}));
    expect(ctl.getAuthorizedSessionSpy).toHaveBeenCalledWith(expect.anything(), {
      allowReadonlyBearer: false,
    });
  });
});
