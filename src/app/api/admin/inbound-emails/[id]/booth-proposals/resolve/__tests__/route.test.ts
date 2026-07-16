/**
 * OPE-205 §2 write-half — approve/reject a staged booth identification. This is
 * a public-vendor write path, so the branches that must NOT write (no name, no
 * event, already resolved) are pinned alongside the happy path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
const createOrLinkVendorMock = vi.fn();
const inserted: Array<Record<string, unknown>> = [];
// Queue of results the mocked SELECT chain returns, in call order.
let selectResults: unknown[][] = [];

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@takemetothefair/vendor-linking", () => ({
  createOrLinkVendor: (...a: unknown[]) => createOrLinkVendorMock(...a),
}));
vi.mock("@/lib/completeness", () => ({ recomputeVendorCompleteness: vi.fn() }));
vi.mock("@/lib/enrichment-log", () => ({ logEnrichment: vi.fn() }));
vi.mock("@/lib/upload-image-pipeline", () => ({ runUploadPipeline: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: () => ({ VENDOR_ASSETS: undefined }),
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResults.shift() ?? []) }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  }),
}));

import { POST } from "../route";

const req = (body: unknown) =>
  new Request("http://localhost/api/admin/inbound-emails/e1/booth-proposals/resolve", {
    method: "POST",
    body: JSON.stringify(body),
  });
const params = { params: Promise.resolve({ id: "e1" }) };

const proposal = (payload: unknown) => [{ id: "prop-1", payloadJson: JSON.stringify(payload) }];

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { role: "ADMIN", id: "admin-1" } });
  createOrLinkVendorMock.mockReset();
  inserted.length = 0;
  selectResults = [];
});

describe("POST booth-proposals/resolve", () => {
  it("is admin-only", async () => {
    authMock.mockResolvedValue({ user: { role: "USER" } });
    expect((await POST(req({ proposal_id: "p", action: "reject" }), params)).status).toBe(401);
  });

  it("rejects a bad body", async () => {
    expect((await POST(req({ action: "approve" }), params)).status).toBe(400);
    expect((await POST(req({ proposal_id: "p", action: "sideways" }), params)).status).toBe(400);
  });

  it("404s a proposal that isn't on this email", async () => {
    selectResults = [[]]; // proposal lookup misses
    expect((await POST(req({ proposal_id: "x", action: "reject" }), params)).status).toBe(404);
  });

  it("409s an already-resolved proposal — no double-create on a double-click", async () => {
    selectResults = [proposal({ event_id: "ev1", business_name: "X" }), [{ payloadJson: "{}" }]];
    const res = await POST(req({ proposal_id: "prop-1", action: "approve" }), params);
    expect(res.status).toBe(409);
    expect(createOrLinkVendorMock).not.toHaveBeenCalled();
  });

  it("reject writes a resolved row and never touches the vendor tail", async () => {
    selectResults = [proposal({ event_id: "ev1", business_name: "X" }), []];
    const res = await POST(req({ proposal_id: "prop-1", action: "reject" }), params);
    expect(res.status).toBe(200);
    expect(createOrLinkVendorMock).not.toHaveBeenCalled();
    expect(inserted[0].action).toBe("vendor.photo_resolved");
    expect(JSON.parse(inserted[0].payloadJson as string).resolution).toBe("rejected");
  });

  it("approve calls the shared write tail and records the vendor", async () => {
    selectResults = [proposal({ event_id: "ev1", business_name: "Maple Farm" }), []];
    createOrLinkVendorMock.mockResolvedValue({
      ok: true,
      vendorId: "v-1",
      vendorSlug: "maple-farm",
      wasCreated: true,
      wasLinked: true,
      wasAlreadyLinked: false,
      matchedExisting: null,
    });
    const res = await POST(req({ proposal_id: "prop-1", action: "approve" }), params);
    const body = (await res.json()) as { vendor_id: string; resolution: string };
    expect(res.status).toBe(200);
    expect(body.vendor_id).toBe("v-1");
    expect(body.resolution).toBe("approved");
    // The business name from the payload flowed into the write.
    expect(createOrLinkVendorMock.mock.calls[0][1].businessName).toBe("Maple Farm");
    // A resolved row was written.
    expect(inserted.some((r) => r.action === "vendor.photo_resolved")).toBe(true);
  });

  it("refuses to approve an unidentified photo without a typed name", async () => {
    selectResults = [proposal({ event_id: "ev1", business_name: null }), []];
    const res = await POST(req({ proposal_id: "prop-1", action: "approve" }), params);
    expect(res.status).toBe(400);
    expect(createOrLinkVendorMock).not.toHaveBeenCalled();
  });

  it("approves an unidentified photo when a corrected_name is supplied", async () => {
    selectResults = [proposal({ event_id: "ev1", business_name: null }), []];
    createOrLinkVendorMock.mockResolvedValue({
      ok: true,
      vendorId: "v-2",
      vendorSlug: "corrected",
      wasCreated: true,
      wasLinked: true,
      wasAlreadyLinked: false,
      matchedExisting: null,
    });
    const res = await POST(
      req({ proposal_id: "prop-1", action: "approve", corrected_name: "Corrected Co" }),
      params
    );
    expect(res.status).toBe(200);
    expect(createOrLinkVendorMock.mock.calls[0][1].businessName).toBe("Corrected Co");
  });

  it("422s when the proposal has no resolved event", async () => {
    selectResults = [proposal({ business_name: "X" }), []]; // no event_id
    const res = await POST(req({ proposal_id: "prop-1", action: "approve" }), params);
    expect(res.status).toBe(422);
    expect(createOrLinkVendorMock).not.toHaveBeenCalled();
  });

  it("surfaces a core failure as 422", async () => {
    selectResults = [proposal({ event_id: "ev1", business_name: "X" }), []];
    createOrLinkVendorMock.mockResolvedValue({ ok: false, error: "Event not found: ev1" });
    const res = await POST(req({ proposal_id: "prop-1", action: "approve" }), params);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("Event not found");
  });
});
