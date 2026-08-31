/**
 * OPE-694 — every Browser Rendering attempt is counted, including the ones
 * that succeed.
 *
 * The blindness this removes is specific and it already cost a wrong ticket
 * framing: BR left a record only when the STANDARD path also failed, so "never
 * fired" and "always failed" were the same observation. OPE-694 was filed
 * saying BR was "0-for-2 with no success since 2026-07-19"; what the data
 * actually supported was "not exercised since the 2026-08-24 remedy deployed
 * at 14:37:56Z", every recorded 422 predating it by at least 36 minutes.
 *
 * A structural test guards the wiring, because instrumenting two of three call
 * sites would make the count read low and look like a finding.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordBrowserRenderingAttempt, BR_ATTEMPT_PREFIX } from "../browser-rendering-attempt";

const ROOT = join(__dirname, "..", "..", "..");

vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

describe("recordBrowserRenderingAttempt", () => {
  it("records a SUCCESS, not only failures", async () => {
    // The half that was missing. Successes were only ever implied by
    // inbound_emails.fetch_method, which does not exist for the harvest lane.
    const { logError } = await import("@/lib/logger");
    await recordBrowserRenderingAttempt({} as never, {
      url: "https://example.test/e",
      trigger: "empty-extraction",
      ok: true,
      status: 200,
    });
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        level: "info",
        message: `${BR_ATTEMPT_PREFIX} ok (empty-extraction)`,
      })
    );
  });

  it("carries the API's own error text, not just the status", async () => {
    // A status code is not a diagnosis — the lesson PR #1018 recorded when it
    // stopped discarding the 422 body. Losing it here would re-create exactly
    // the blindness that made "browser-rendering-http-422" the whole of what
    // we knew for five weeks.
    const { logError } = await import("@/lib/logger");
    vi.mocked(logError).mockClear();
    await recordBrowserRenderingAttempt({} as never, {
      url: "https://example.test/e",
      trigger: "status-escalation",
      ok: false,
      status: 422,
      error: "browser-rendering-http-422: navigation timeout",
    });
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        context: expect.objectContaining({
          status: 422,
          error: "browser-rendering-http-422: navigation timeout",
        }),
      })
    );
  });

  it("NEVER throws, even when logging itself fails", async () => {
    // A measurement that can break the thing it measures is worse than the
    // blindness it replaces. This path exists to observe a rare escalation —
    // it must not be able to turn a working fetch into a failed one.
    const { logError } = await import("@/lib/logger");
    vi.mocked(logError).mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(
      recordBrowserRenderingAttempt({} as never, {
        url: "https://example.test/e",
        trigger: "status-escalation",
        ok: false,
        status: 422,
      })
    ).resolves.toBeUndefined();
  });
});

describe("every Browser Rendering call site is instrumented", () => {
  it.each([
    "src/app/api/admin/import-url/fetch/route.ts",
    "src/app/api/internal/harvest-fetch/route.ts",
  ])("%s records its attempts", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const calls = (src.match(/fetchViaBrowserRendering\(/g) ?? []).length;
    const records = (src.match(/recordBrowserRenderingAttempt\(/g) ?? []).length;
    expect(calls).toBeGreaterThan(0);
    // One record per call. Instrumenting some of them makes the count read low
    // and look like a finding about Browser Rendering rather than about us.
    expect(records).toBe(calls);
  });
});
