/**
 * OPE-1650 — the recompute route answers a failure with a classified body.
 * It used to let the error escape, so the cron logged "500 with no body
 * (likely a Worker resource kill)" for what was a 10 s GA4 timeout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const kpi = vi.hoisted(() => ({
  recomputeKpiStates: vi.fn(),
  pruneKpiStateHistory: vi.fn(),
}));
vi.mock("@/lib/kpi-states", () => kpi);
vi.mock("@/lib/api-auth", () => ({ requireAdminAuth: vi.fn(async () => null) }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => ({})),
  getCloudflareEnv: vi.fn(() => ({})),
}));

import { POST } from "../route";

const req = () => new Request("https://x/api/admin/kpi-recompute", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  kpi.recomputeKpiStates.mockResolvedValue({ written: 5, transitions: 0, resolved: 0 });
  kpi.pruneKpiStateHistory.mockResolvedValue({ deleted: 0 });
});

describe("POST /api/admin/kpi-recompute", () => {
  it("positive landmark: success still answers 200 with the counts", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, written: 5 });
  });

  it("a recompute failure → 500 with stage, error name and message (never an empty body)", async () => {
    kpi.recomputeKpiStates.mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError")
    );
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      stage: "recompute",
      error: "AbortError",
      message: "The operation was aborted",
    });
    expect(kpi.pruneKpiStateHistory).not.toHaveBeenCalled();
  });

  it("a prune failure is reported as the prune stage", async () => {
    kpi.pruneKpiStateHistory.mockRejectedValue(new Error("D1_ERROR: overloaded"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ stage: "prune", error: "Error" });
  });
});
