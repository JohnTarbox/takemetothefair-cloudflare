/**
 * Tests for the requireVerifiedSession + targetUserIsVerified gate
 * helpers. These guard the three vendor surfaces added in PR #227
 * (profile EDIT, event-application submission, contact-form forward).
 * The unit boundary tested here is the response shape — happy path
 * returns `{ ok: true, userId, email }`; each failure mode returns a
 * `NextResponse` with the documented JSON body and status code.
 *
 * `auth()` and `getCloudflareDb()` are mocked at the module level so
 * the helper runs against synthetic session + DB state — same
 * approach as src/lib/__tests__/api-auth-bearer.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the session + DB layer BEFORE importing the module under test.
// Vitest hoists vi.mock above imports automatically; the factories run
// once per file.
type MockedAuth = () => Promise<{ user: { id: string; email: string } } | null>;
const mockedAuth: ReturnType<typeof vi.fn> & MockedAuth = vi.fn() as ReturnType<typeof vi.fn> &
  MockedAuth;
vi.mock("@/lib/auth", () => ({
  auth: () => mockedAuth(),
}));

interface MockedUser {
  emailVerified: Date | null;
}
const userById = new Map<string, MockedUser>();

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            // The where clause from the helper is
            // `eq(users.id, session.user.id)`. We can't easily inspect
            // the Drizzle condition object here without pulling in the
            // full ORM; instead we capture the session's userId via
            // the most-recent auth() return and use that as the lookup
            // key.
            const session = await mockedAuth();
            const userId = session?.user?.id;
            if (!userId) return [];
            const user = userById.get(userId);
            return user ? [{ emailVerified: user.emailVerified }] : [];
          },
        }),
      }),
    }),
  }),
}));

const { requireVerifiedSession, targetUserIsVerified } = await import("../api-auth");

beforeEach(() => {
  mockedAuth.mockReset();
  userById.clear();
});

describe("requireVerifiedSession", () => {
  it("returns ok=true with userId and email when the user is verified", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "u-1", email: "a@b.com" } });
    userById.set("u-1", { emailVerified: new Date("2026-01-01") });

    const result = await requireVerifiedSession();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("u-1");
      expect(result.email).toBe("a@b.com");
    }
  });

  it("returns 401 Unauthorized when no session", async () => {
    mockedAuth.mockResolvedValue(null);

    const result = await requireVerifiedSession();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ error: "Unauthorized" });
    }
  });

  it("returns 401 when session has no user.id", async () => {
    // Defensive: session exists but is malformed (no id). NextAuth
    // shouldn't produce this shape but the helper should still fail
    // closed.
    mockedAuth.mockResolvedValue({ user: { id: "", email: "a@b.com" } });

    const result = await requireVerifiedSession();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 403 email_unverified when user.emailVerified is null", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "u-2", email: "x@y.com" } });
    userById.set("u-2", { emailVerified: null });

    const result = await requireVerifiedSession();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as {
        error: string;
        message: string;
        verifyUrl: string;
      };
      expect(body.error).toBe("email_unverified");
      expect(body.message).toContain("verify");
      // verifyUrl points at the resend endpoint so a frontend can wire
      // a "Resend verification" button straight into the 403 body.
      expect(body.verifyUrl).toBe("/api/auth/send-verification");
    }
  });

  it("returns 403 when the user row is missing entirely", async () => {
    // Defensive: session valid but user row deleted between auth() and
    // the helper's DB lookup. Treat as unverified.
    mockedAuth.mockResolvedValue({ user: { id: "vanished", email: "g@h.com" } });
    // intentionally no userById entry

    const result = await requireVerifiedSession();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("email_unverified");
    }
  });
});

describe("targetUserIsVerified", () => {
  it("returns true when the target user has emailVerified set", async () => {
    userById.set("u-target", { emailVerified: new Date() });
    // The anonymous variant calls auth() too (through the mocked db),
    // so seed the mock with a session that doesn't matter for the
    // result.
    mockedAuth.mockResolvedValue({ user: { id: "u-target", email: "t@x.com" } });

    expect(await targetUserIsVerified("u-target")).toBe(true);
  });

  it("returns false when emailVerified is null", async () => {
    userById.set("u-unverified", { emailVerified: null });
    mockedAuth.mockResolvedValue({ user: { id: "u-unverified", email: "u@x.com" } });

    expect(await targetUserIsVerified("u-unverified")).toBe(false);
  });

  it("returns false when userId is null (placeholder vendor)", async () => {
    expect(await targetUserIsVerified(null)).toBe(false);
  });

  it("returns false when the user row is missing", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "u-missing", email: "m@x.com" } });
    expect(await targetUserIsVerified("u-missing")).toBe(false);
  });
});
