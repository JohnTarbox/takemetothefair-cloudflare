import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the low-level MP sender so we assert the event contract (name + params)
// without any network / Cloudflare-context dependency.
const sendMock = vi.fn();
vi.mock("@/lib/ga4-measurement-protocol", () => ({
  sendGa4MeasurementProtocol: (...args: unknown[]) => sendMock(...args),
}));

import {
  isSmokeTestEntityId,
  trackClaimViewServer,
  trackClaimAccountCreatedServer,
  trackClaimVerificationAttemptedServer,
  trackClaimCompletedServer,
} from "../claim-funnel";

beforeEach(() => {
  sendMock.mockReset();
});

/** Pull the single event object out of the last sendGa4MeasurementProtocol call. */
function lastEvent() {
  const [clientId, events] = sendMock.mock.calls.at(-1)!;
  return { clientId, event: events[0] };
}

describe("isSmokeTestEntityId", () => {
  it("filters the known smoke-test fixtures and empty slugs", () => {
    expect(isSmokeTestEntityId("test-vendor")).toBe(true);
    expect(isSmokeTestEntityId("test-vendor-co")).toBe(true);
    expect(isSmokeTestEntityId("test-promoter")).toBe(true);
    expect(isSmokeTestEntityId("")).toBe(true);
    expect(isSmokeTestEntityId("   ")).toBe(true);
    expect(isSmokeTestEntityId("acme-smoke-test-42")).toBe(true);
    expect(isSmokeTestEntityId("TEST-VENDOR")).toBe(true); // case-insensitive
  });

  it("passes real slugs through", () => {
    expect(isSmokeTestEntityId("maine-lobster-festival")).toBe(false);
    expect(isSmokeTestEntityId("acme-corp")).toBe(false);
  });
});

describe("claim-funnel server events", () => {
  it("claim_view_server carries entity_type (lowercased) + entity_id + transport", async () => {
    await trackClaimViewServer({
      clientId: "111.222",
      entityType: "VENDOR",
      entitySlug: "acme-corp",
    });
    const { clientId, event } = lastEvent();
    expect(clientId).toBe("111.222");
    expect(event.name).toBe("claim_view_server");
    expect(event.params).toEqual({
      transport: "server",
      entity_type: "vendor",
      entity_id: "acme-corp",
    });
  });

  it("claim_account_created_server uses the promoter dim value", async () => {
    await trackClaimAccountCreatedServer({
      clientId: "c",
      entityType: "PROMOTER",
      entitySlug: "big-fair-co",
    });
    const { event } = lastEvent();
    expect(event.name).toBe("claim_account_created_server");
    expect(event.params.entity_type).toBe("promoter");
    expect(event.params.entity_id).toBe("big-fair-co");
  });

  it("claim_verification_attempted_server includes the method dimension", async () => {
    await trackClaimVerificationAttemptedServer({
      clientId: "c",
      entityType: "VENDOR",
      entitySlug: "acme-corp",
      method: "EVIDENCE",
    });
    const { event } = lastEvent();
    expect(event.name).toBe("claim_verification_attempted_server");
    expect(event.params.method).toBe("EVIDENCE");
    expect(event.params.entity_type).toBe("vendor");
  });

  it("claim_completed_server includes the method dimension", async () => {
    await trackClaimCompletedServer({
      clientId: "c",
      entityType: "VENDOR",
      entitySlug: "acme-corp",
      method: "EMAIL_MATCH",
    });
    const { event } = lastEvent();
    expect(event.name).toBe("claim_completed_server");
    expect(event.params.method).toBe("EMAIL_MATCH");
  });

  it("does NOT emit for smoke-test entity_ids (any of the four events)", async () => {
    await trackClaimViewServer({ clientId: "c", entityType: "VENDOR", entitySlug: "test-vendor" });
    await trackClaimAccountCreatedServer({
      clientId: "c",
      entityType: "VENDOR",
      entitySlug: "test-vendor",
    });
    await trackClaimVerificationAttemptedServer({
      clientId: "c",
      entityType: "VENDOR",
      entitySlug: "test-vendor",
      method: "EVIDENCE",
    });
    await trackClaimCompletedServer({
      clientId: "c",
      entityType: "VENDOR",
      entitySlug: "test-vendor",
      method: "EMAIL_MATCH",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
