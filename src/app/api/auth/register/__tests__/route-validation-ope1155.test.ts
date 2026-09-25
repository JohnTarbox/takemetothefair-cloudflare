/**
 * OPE-1155 — through the route:
 *   1. a website value can never block the account (every one below reaches
 *      the Turnstile step, which only runs AFTER validation passed);
 *   2. a validation refusal names its field(s), to the form AND to
 *      registration_attempts.detail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null, hashPassword: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
  rateLimitResponse: vi.fn(),
}));
const recorded: Array<{ outcome: string; detail?: string | null }> = [];
vi.mock("@/lib/auth/record-registration-attempt", () => ({
  recordRegistrationAttempt: async (_db: unknown, a: { outcome: string; detail?: string | null }) =>
    void recorded.push(a),
}));
// Turnstile refuses every request, so a 400 carrying THIS message proves the
// body got past schema validation.
vi.mock("@/lib/turnstile", () => ({
  verifyTurnstileToken: async () => ({ success: false, errorCodes: ["test-refusal"] }),
  getTurnstileErrorMessage: () => "TURNSTILE_REACHED",
}));

import { POST } from "../route";

type Body = { error?: string; fieldErrors: Record<string, string> };
const json = async (res: Response) => (await res.json()) as Body;

function post(body: unknown) {
  return POST(
    new Request("https://meetmeatthefair.com/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
}

const validVendor = {
  email: "maker@gmail.com",
  password: "correct-horse",
  name: "Pat Maker",
  role: "VENDOR",
  companyName: "",
  businessName: "Pine Pond Pottery",
};

beforeEach(() => {
  recorded.length = 0;
});

describe("OPE-1155 — a website value never blocks the account", () => {
  it.each([
    "https://my site.com",
    "https://mysite.com https://www.facebook.com/mysite",
    "https://example.com:99999",
    "https://www.etsy.com/shop/PinePondPottery",
    "https://www.instagram.com/some.maker/?igsh=abc",
    "http://example.com",
    "www.example.com",
    "http://169.254.169.254/latest/meta-data",
    `https://example.com/${"a".repeat(3000)}`,
  ])("website %j passes validation", async (website) => {
    const res = await post({ ...validVendor, website });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("TURNSTILE_REACHED");
    expect(recorded.map((r) => r.outcome)).not.toContain("validation");
  });
});

describe("OPE-1155 — a validation refusal names its field", () => {
  it("returns fieldErrors and records every failing field", async () => {
    const res = await post({ ...validVendor, password: "short", role: "ADMIN" });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(Object.keys(data.fieldErrors).sort()).toEqual(["password", "role"]);
    expect(data.fieldErrors.password).toBe("Password must be at least 8 characters");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome).toBe("validation");
    expect(recorded[0].detail).toMatch(/^password: Password must be at least 8 characters; role: /);
    // Never the submitted password.
    expect(recorded[0].detail).not.toContain("short");
  });

  it("a default zod message is the English one, not the bare fallback", async () => {
    // ⚠️ Instrument limit: vitest loads zod's locale via the classic entry
    // regardless, so this pins the message SHAPE; the bundle-level defect is
    // verified by the post-deploy production probe on the ticket.
    const res = await post({ ...validVendor, email: 123 });
    const data = await json(res);
    expect(data.fieldErrors.email).not.toBe("Invalid input");
    expect(data.fieldErrors.email).toMatch(/expected string/);
  });
});
