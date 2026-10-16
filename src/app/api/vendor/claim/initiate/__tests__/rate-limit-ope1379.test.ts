/**
 * OPE-1379 (HARD9) — POST /api/vendor/claim/initiate mints a claim token and
 * enqueues a confirmation email on every call. Before this ticket it had no
 * rate limit, so a signed-in user could resend that email without bound.
 *
 * This runs the REAL limiter (src/lib/rate-limit.ts) against an in-memory KV,
 * so it pins both that the route calls it and that the policy is 5/hour/user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { vendors, users } from "@/lib/db/schema";

const ctl = vi.hoisted(() => ({
  userId: "user-1",
  kvStore: new Map<string, string>(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: ctl.userId, email: "claimer@example.com" } })),
}));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({ ok: true, userId: ctl.userId })),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      RATE_LIMIT_KV: {
        get: async (k: string) => ctl.kvStore.get(k) ?? null,
        put: async (k: string, v: string) => void ctl.kvStore.set(k, v),
      },
    },
  }),
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({
    select: vi.fn(() => {
      let table: unknown;
      const chain = {
        from: vi.fn((t: unknown) => ((table = t), chain)),
        where: vi.fn(() => chain),
        limit: vi.fn(async () =>
          table === vendors
            ? [
                {
                  id: "v1",
                  businessName: "Acme Kettle Corn",
                  slug: "acme",
                  userId: ctl.userId,
                  claimed: false,
                  contactEmail: "owner@acme.example",
                },
              ]
            : table === users
              ? [{ email: "claimer@example.com" }]
              : []
        ),
      };
      return chain;
    }),
  })),
}));
vi.mock("@/lib/vendor-claim-token", () => ({
  createClaimToken: vi.fn(async () => ({ rawToken: "tok" })),
}));
vi.mock("@/lib/email/send", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/email/templates", () => ({
  vendorClaimVerificationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
}));
const enqueueEmail = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/queues/producers", () => ({ enqueueEmail }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { POST } from "../route";

function req() {
  return new Request("https://example.test/api/vendor/claim/initiate", {
    method: "POST",
    headers: { "CF-Connecting-IP": "1.2.3.4" },
  });
}

beforeEach(() => {
  ctl.kvStore.clear();
  ctl.userId = "user-1";
  enqueueEmail.mockClear();
});

describe("OPE-1379 — vendor claim initiate is rate limited per user", () => {
  it("admits 5 sends in an hour and refuses the 6th with a 429, without sending", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await POST(req());
      expect(res.status).toBe(200);
    }
    expect(enqueueEmail).toHaveBeenCalledTimes(5);

    const refused = await POST(req());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    // The 6th call must not mint/send anything.
    expect(enqueueEmail).toHaveBeenCalledTimes(5);
  });

  it("keys on the user — a different user is admitted after the first is exhausted", async () => {
    for (let i = 0; i < 6; i++) await POST(req());
    ctl.userId = "user-2";
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect([...ctl.kvStore.keys()]).toEqual(
      expect.arrayContaining([
        "rate:vendor-claim-initiate:user:user-1",
        "rate:vendor-claim-initiate:user:user-2",
      ])
    );
  });
});
