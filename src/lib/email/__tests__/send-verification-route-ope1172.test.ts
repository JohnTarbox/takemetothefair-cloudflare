/**
 * OPE-1172 AC2 — the route layer. Separate file because its `vi.mock` of
 * `@/lib/email/undeliverable` is hoisted and would replace the real helper
 * that undeliverable-ope1172.test.ts exercises.
 *
 * What matters here is ORDER: the check runs before the user lookup, so the
 * answer depends only on the address and is never an account-existence oracle.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── The route ────────────────────────────────────────────────────────────────
const undeliverable = vi.fn();
const enqueueEmail = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/email/undeliverable", async (orig) => ({
  ...(await orig<object>()),
  isAddressUndeliverable: (...a: unknown[]) => undeliverable(...a),
}));
vi.mock("@/lib/queues/producers", () => ({
  enqueueEmail: (...a: unknown[]) => enqueueEmail(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
  rateLimitResponse: () => null,
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "Typo@Exmaple.com" } }) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    query: { users: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    insert: () => ({ values: async () => undefined }),
  }),
}));

describe("POST /api/auth/send-verification (OPE-1172 AC2)", () => {
  beforeEach(() => {
    undeliverable.mockReset();
    enqueueEmail.mockReset();
    findFirst.mockReset();
  });
  const post = async () => {
    const { POST } = await import("@/app/api/auth/send-verification/route");
    return POST(
      new Request("https://x/api/auth/send-verification", { method: "POST", body: "{}" }) as never
    );
  };

  it("an undeliverable address: sends nothing, returns 422 with the address, never looks up the user", async () => {
    undeliverable.mockResolvedValue(true);
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, undeliverable: true, email: "typo@exmaple.com" });
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("LANDMARK: a deliverable address for an unverified user still enqueues one email", async () => {
    undeliverable.mockResolvedValue(false);
    findFirst.mockResolvedValue({ email: "typo@exmaple.com", name: "T", emailVerified: null });
    const res = await post();
    expect(res.status).toBe(200);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail.mock.calls[0][0]).toMatchObject({ source: "auth.send-verification" });
  });
});
