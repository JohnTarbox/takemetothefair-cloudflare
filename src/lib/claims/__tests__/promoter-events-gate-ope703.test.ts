/**
 * OPE-703 — promoter event creation refuses an unverified session.
 *
 * These exercise `requireVerifiedSession` itself, which is the shared decision
 * both routes now delegate to. The OPE-238 sweep test proves the routes CALL
 * it; this proves what it answers, so the pair covers "is it wired" and "does
 * it say no" rather than only the first.
 *
 * The last case is the one that matters most and is easy to omit: the gate must
 * fail CLOSED when its own lookup throws. A verification gate that opens on a
 * DB blip is not a gate — it is a gate-shaped thing that disappears exactly
 * when the database is unhappy, which is when nobody is watching it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAuth = vi.fn();
const mockSelect = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => mockSelect() }) }),
    }),
  }),
}));

const SESSION = { user: { id: "u-1", email: "promoter@example.test" } };

async function runGate() {
  const { requireVerifiedSession } = await import("@/lib/api-auth");
  return requireVerifiedSession();
}

beforeEach(() => {
  vi.resetModules();
  mockAuth.mockReset();
  mockSelect.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("requireVerifiedSession — the gate promoter/events now runs", () => {
  it("REFUSES an unverified account with 403 email_unverified", async () => {
    mockAuth.mockResolvedValue(SESSION);
    mockSelect.mockResolvedValue([{ emailVerified: null }]);

    const gate = await runGate();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.response.status).toBe(403);
    const body = (await gate.response.json()) as { error: string; verifyUrl?: string };
    expect(body.error).toBe("email_unverified");
    // The refusal has to carry the way out, or a blocked promoter is stuck on
    // the one action they came to perform.
    expect(body.verifyUrl).toBe("/api/auth/send-verification");
  });

  it("ALLOWS a verified account through", async () => {
    // The other half, and not a formality: a gate that refuses everyone would
    // pass the test above while blocking all six real promoters.
    mockAuth.mockResolvedValue(SESSION);
    mockSelect.mockResolvedValue([{ emailVerified: new Date("2026-08-01") }]);

    const gate = await runGate();
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error("unreachable");
    expect(gate.userId).toBe("u-1");
  });

  it("refuses an anonymous caller with 401, not 403", async () => {
    // 403 says "verify your email"; to somebody who never signed in that is
    // confusing advice. The distinction is worth keeping.
    mockAuth.mockResolvedValue(null);
    const gate = await runGate();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.response.status).toBe(401);
  });

  it("FAILS CLOSED when the verification lookup throws", async () => {
    // The case worth writing the file for. A gate that opens on a DB error
    // vanishes precisely when the system is already unhealthy.
    mockAuth.mockResolvedValue(SESSION);
    mockSelect.mockRejectedValue(new Error("D1 unavailable"));

    const gate = await runGate();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.response.status).toBe(503);
    const body = (await gate.response.json()) as { error: string };
    expect(body.error).toBe("verification_check_failed");
  });

  it("refuses when the user row has vanished", async () => {
    // Deleted account with a live cookie. `user?.emailVerified` must read as
    // unverified rather than throwing or passing.
    mockAuth.mockResolvedValue(SESSION);
    mockSelect.mockResolvedValue([]);
    const gate = await runGate();
    expect(gate.ok).toBe(false);
  });
});
