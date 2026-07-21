/**
 * OPE-226 — the scan route actually calls the snapshot writer.
 *
 * This is a GLUE test on purpose. The snapshot maths is unit-tested in
 * src/lib/photo-effectiveness/__tests__/model.test.ts and passes there whether
 * or not anything ever invokes it. The recurring defect in this codebase is not
 * broken logic, it is correct logic with no caller — OPE-225 itself shipped a
 * scan route that nothing called, and the table sat empty while the tests were
 * green. So the assertions here are about the WIRING:
 *
 *   1. a completed scan persists a snapshot flagged complete;
 *   2. a TRUNCATED scan still persists, flagged incomplete, and still 500s —
 *      because a missing day reads downstream as "coverage unchanged", which is
 *      indistinguishable from a healthy metric;
 *   3. a snapshot failure never turns a good scan into a failed one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshImageCoverageState = vi.fn();
const loadCoverageState = vi.fn();
const persistPhotoCoverageSnapshot = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/api/with-auth", () => ({
  // Identity: the auth wrapper is exercised by its own tests.
  withInternalKey: (handler: unknown) => handler,
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => ({ __db: true }) }));
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/photo-coverage/scan", () => ({
  refreshImageCoverageState: (...a: unknown[]) => refreshImageCoverageState(...a),
}));
vi.mock("@/lib/photo-effectiveness/load", () => ({
  loadCoverageState: (...a: unknown[]) => loadCoverageState(...a),
  persistPhotoCoverageSnapshot: (...a: unknown[]) => persistPhotoCoverageSnapshot(...a),
}));

const { POST } = await import("../route");

const scanResult = (complete: boolean) => ({
  scanned: 2,
  inserted: 2,
  updated: 0,
  newlyImaged: 0,
  imageless: 1,
  hotlinked: 0,
  writtenByType: complete ? { EVENT: 2 } : { EVENT: 1 },
  complete,
});

const call = () => (POST as unknown as (a: unknown) => Promise<Response>)({});

beforeEach(() => {
  vi.clearAllMocks();
  loadCoverageState.mockResolvedValue([{ entityType: "EVENT" }]);
  persistPhotoCoverageSnapshot.mockResolvedValue({ date: "2026-07-21", written: 4 });
});

describe("POST /api/internal/photo-coverage/scan — snapshot wiring", () => {
  it("persists a snapshot after a completed scan, flagged complete", async () => {
    refreshImageCoverageState.mockResolvedValue(scanResult(true));

    const res = await call();
    expect(res.status).toBe(200);

    expect(persistPhotoCoverageSnapshot).toHaveBeenCalledTimes(1);
    // 3rd arg is the completeness flag carried onto every snapshot row.
    expect(persistPhotoCoverageSnapshot.mock.calls[0][2]).toBe(true);

    const body = (await res.json()) as { snapshot: { written: number } };
    expect(body.snapshot.written).toBe(4);
  });

  it("still persists — flagged INCOMPLETE — when the scan truncated, and still 500s", async () => {
    refreshImageCoverageState.mockResolvedValue(scanResult(false));

    const res = await call();
    expect(res.status).toBe(500);

    expect(persistPhotoCoverageSnapshot).toHaveBeenCalledTimes(1);
    expect(persistPhotoCoverageSnapshot.mock.calls[0][2]).toBe(false);

    const body = (await res.json()) as { incomplete: boolean; snapshot: unknown };
    expect(body.incomplete).toBe(true);
    expect(body.snapshot).not.toBeNull();
  });

  it("does not fail a good scan when the snapshot write throws", async () => {
    refreshImageCoverageState.mockResolvedValue(scanResult(true));
    persistPhotoCoverageSnapshot.mockRejectedValue(new Error("d1 unavailable"));

    const res = await call();
    expect(res.status).toBe(200);
    // Fail-soft, but never silent — this is why the writer has its own
    // heartbeat probe rather than riding on the scan's.
    expect(logError).toHaveBeenCalled();
  });

  it("passes the SAME clock to the scan and the snapshot", async () => {
    // A snapshot stamped from a second `new Date()` can land on the next UTC
    // day either side of midnight, splitting one scan across two dates.
    refreshImageCoverageState.mockResolvedValue(scanResult(true));
    await call();

    const scanNow = refreshImageCoverageState.mock.calls[0][1] as Date;
    const snapNow = persistPhotoCoverageSnapshot.mock.calls[0][3] as Date;
    expect(snapNow).toBe(scanNow);
  });
});
