/**
 * OPE-225 — the daily driver for the photo-coverage scan.
 *
 * Worth testing despite being a thin fetch wrapper: PR 1 shipped the scan route
 * with NO caller, which is the OPE-245 shape (a ranker that shipped and was
 * never invoked, leaving 6,121 rows NULL-scored from ship). These assert the
 * canary actually posts to the right URL with auth, and that a bad response
 * can never throw out of the cron branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runScheduledPhotoCoverageScan } from "../src/photo-coverage-canary.js";

vi.mock("../src/logger.js", () => ({ logError: vi.fn(async () => {}) }));

type Env = Parameters<typeof runScheduledPhotoCoverageScan>[0];

const envWith = (fetchImpl: ReturnType<typeof vi.fn>): Env =>
  ({
    DB: {} as unknown,
    INTERNAL_API_KEY: "k-123",
    MAIN_APP: { fetch: fetchImpl },
  }) as unknown as Env;

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => vi.clearAllMocks());

describe("runScheduledPhotoCoverageScan", () => {
  it("POSTs the internal scan endpoint with the internal key", async () => {
    const f = ok({ scanned: 1402, newlyImaged: 3, imageless: 752, hotlinked: 24 });
    await runScheduledPhotoCoverageScan(envWith(f));

    expect(f).toHaveBeenCalledTimes(1);
    const req = f.mock.calls[0][0] as Request;
    expect(req.url).toBe("https://meetmeatthefair.com/api/internal/photo-coverage/scan");
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-Internal-Key")).toBe("k-123");
  });

  it("swallows a non-2xx — a canary failure must not trip cron retry", async () => {
    const f = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(runScheduledPhotoCoverageScan(envWith(f))).resolves.toBeUndefined();
  });

  it("swallows a thrown fetch for the same reason", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(runScheduledPhotoCoverageScan(envWith(f))).resolves.toBeUndefined();
  });

  it("tolerates a 200 with an unparseable body", async () => {
    const f = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(runScheduledPhotoCoverageScan(envWith(f))).resolves.toBeUndefined();
  });
});
