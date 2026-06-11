/**
 * Tests for POST /api/analytics/track — ENG1.8 GA4 Measurement Protocol
 * mirror wiring. Focus: the two outbound click names mirror to GA4 with the
 * five derived params; everything else (and invalid input) does NOT. The
 * helper's own send/parse behavior is covered in
 * src/lib/__tests__/ga4-measurement-protocol.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type MpEvent = { name: string; params: Record<string, string | number> };
const sendSpy = vi.hoisted(() =>
  vi.fn(async (_clientId: string, _events: MpEvent[]): Promise<void> => undefined)
);

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 60,
    limit: 60,
    resetAt: 0,
    isAuthenticated: false,
  })),
  rateLimitResponse: vi.fn(),
}));
// Keep parseGaClientId + safeHostname real (so param derivation is genuinely
// exercised); only stub the network send.
vi.mock("@/lib/ga4-measurement-protocol", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ga4-measurement-protocol")>();
  return { ...actual, sendGa4MeasurementProtocol: sendSpy };
});

import { POST } from "../route";

function makeRequest(body: unknown, cookie?: string): Request {
  return new Request("http://localhost:3000/api/analytics/track", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/analytics/track — ENG1.8 GA4 mirror", () => {
  beforeEach(() => sendSpy.mockClear());

  it("mirrors outbound_application_click with the five derived params", async () => {
    const res = await POST(
      makeRequest(
        {
          name: "outbound_application_click",
          category: "conversion",
          properties: {
            eventSlug: "spring-fair-2026",
            destinationUrl: "https://apply.example.com/form?id=9",
          },
        },
        "_ga=GA1.1.111.222"
      )
    );

    expect(res.status).toBe(204);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0];
    expect(call?.[0]).toBe("111.222");
    expect(call?.[1]).toEqual([
      {
        name: "outbound_application_click",
        params: {
          target_url: "https://apply.example.com/form?id=9",
          target_domain: "apply.example.com",
          entity_type: "event",
          entity_id: "spring-fair-2026",
          application_or_ticket: "application",
        },
      },
    ]);
  });

  it("classifies outbound_ticket_click as a ticket handoff", async () => {
    await POST(
      makeRequest({
        name: "outbound_ticket_click",
        category: "conversion",
        properties: { eventSlug: "e1", destinationUrl: "https://t.co/x" },
      })
    );
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[1][0]?.params.application_or_ticket).toBe("ticket");
  });

  it("does NOT mirror a non-outbound event", async () => {
    const res = await POST(makeRequest({ name: "filter_applied", category: "engagement" }));
    expect(res.status).toBe(204);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects an event name outside the allowlist and never mirrors", async () => {
    const res = await POST(makeRequest({ name: "evil_event", category: "conversion" }));
    expect(res.status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
