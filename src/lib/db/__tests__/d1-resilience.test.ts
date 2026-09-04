/**
 * OPE-790 — a weekly Cloudflare D1 blip must stop being a site outage.
 *
 * Three resets in seven days each took the whole browse surface to the error
 * boundary, and the OPE-84 scan correctly ruled all three "not a code defect".
 * The 08-27 one lasted a single second. So the deliverable is not "fix D1" —
 * it is that one retry absorbs a blip a retry can absorb.
 *
 * The two ways this could be built wrong, both pinned below:
 *  - retrying a QUERY DEFECT, which fails identically twice and just doubles
 *    the latency and the error rows;
 *  - absorbing a blip SILENTLY, which makes "the resets stopped" and "we
 *    stopped noticing the resets" look the same in error_logs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyD1Error, withD1Read, type D1RetryOutcome } from "../d1-resilience";
import { FetchError } from "@/lib/errors/fetch-error";

/** The exact strings from OPE-790's incident table, verbatim. */
const OBSERVED_PLATFORM_FAULTS = [
  "D1_ERROR: Network connection lost.",
  "D1_ERROR: d1 db storage operation exceeded timeout",
  "Error: Cannot resolve object to be reset",
  "D1_ERROR: Internal error in D1 DB storage",
  "Worker exceeded its cpu time limit",
];

/** Real failures of OUR SQL, which a retry cannot help. */
const OBSERVED_QUERY_DEFECTS = [
  "D1_ERROR: too many columns in result set: SQLITE_ERROR",
  "D1_ERROR: too many SQL variables at offset 123",
  "D1_ERROR: LIKE or GLOB pattern too complex",
  "D1_ERROR: UNIQUE constraint failed: vendors.slug",
];

describe("classifyD1Error", () => {
  it.each(OBSERVED_PLATFORM_FAULTS)("classifies %s as platform_transient", (msg) => {
    expect(classifyD1Error(new Error(msg))).toBe("platform_transient");
  });

  it.each(OBSERVED_QUERY_DEFECTS)("classifies %s as query_defect", (msg) => {
    expect(classifyD1Error(new Error(msg))).toBe("query_defect");
  });

  it("reads through a FetchError's cause chain", () => {
    // This is load-bearing: the page fetchers throw FetchError wrapping the D1
    // exception, so a classifier that only looked at `e.message` would see
    // "Fetch failed (app/events/page.tsx:getEvents)" and match nothing at all.
    const wrapped = new FetchError(
      "app/events/page.tsx:getEvents",
      new Error("D1_ERROR: d1 db storage operation exceeded timeout")
    );
    expect(classifyD1Error(wrapped)).toBe("platform_transient");
  });

  it("does not guess: an unrecognised error is not retryable", () => {
    expect(classifyD1Error(new Error("something else entirely"))).toBe("unknown");
    expect(classifyD1Error(null)).toBe("unknown");
  });

  it("prefers query_defect when a defect arrives inside a generic D1_ERROR envelope", () => {
    // "too many columns in result set: SQLITE_ERROR" is ours. If the platform
    // list were checked first and happened to overlap, we would retry a query
    // that cannot succeed.
    expect(
      classifyD1Error(new Error("D1_ERROR: too many columns in result set: SQLITE_ERROR"))
    ).toBe("query_defect");
  });
});

describe("withD1Read — one retry, and only where a retry helps", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the value with no retry when the read succeeds", async () => {
    const fn = vi.fn(async () => "ok");
    const outcomes: D1RetryOutcome[] = [];
    expect(await withD1Read(fn, (o) => outcomes.push(o))).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcomes[0].retried).toBe(false);
  });

  it("absorbs a one-second blip: fails once, retries, succeeds", async () => {
    // The 2026-08-27 incident, in miniature.
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls === 1) throw new Error("D1_ERROR: d1 db storage operation exceeded timeout");
      return "events";
    });
    const outcomes: D1RetryOutcome[] = [];
    expect(await withD1Read(fn, (o) => outcomes.push(o))).toBe("events");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(outcomes.at(-1)).toMatchObject({
      retried: true,
      recovered: true,
      firstFaultClass: "platform_transient",
    });
  });

  it("does NOT retry a query defect — it would fail identically twice", async () => {
    const fn = vi.fn(async () => {
      throw new Error("D1_ERROR: too many columns in result set: SQLITE_ERROR");
    });
    const outcomes: D1RetryOutcome[] = [];
    await expect(withD1Read(fn, (o) => outcomes.push(o))).rejects.toThrow(/too many columns/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcomes.at(-1)).toMatchObject({ retried: false, firstFaultClass: "query_defect" });
  });

  it("does not retry an unclassifiable error either", async () => {
    const fn = vi.fn(async () => {
      throw new Error("something else entirely");
    });
    await expect(withD1Read(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries at most ONCE — a retry storm makes a blip longer, not shorter", async () => {
    const fn = vi.fn(async () => {
      throw new Error("D1_ERROR: Internal error in D1 DB storage");
    });
    const outcomes: D1RetryOutcome[] = [];
    await expect(withD1Read(fn, (o) => outcomes.push(o))).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(outcomes.at(-1)).toMatchObject({ retried: true, recovered: false });
  });

  it("rethrows the SECOND failure, so the fetcher's catch sees a live error", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      throw new Error(
        ++calls === 1
          ? "D1_ERROR: Internal error in D1 DB storage"
          : "D1_ERROR: Network connection lost."
      );
    });
    await expect(withD1Read(fn)).rejects.toThrow(/Network connection lost/);
  });

  it("reports a retry outcome even when it recovers, so an absorbed blip stays countable", async () => {
    // Without this, a fully-absorbed reset leaves NO trace anywhere: no user
    // symptom, no server-render row. "The resets stopped" and "we stopped
    // noticing them" would be indistinguishable.
    let calls = 0;
    const fn = async () => {
      if (++calls === 1) throw new Error("Worker exceeded its cpu time limit");
      return 1;
    };
    const outcomes: D1RetryOutcome[] = [];
    await withD1Read(fn, (o) => outcomes.push(o));
    expect(outcomes.some((o) => o.retried && o.recovered)).toBe(true);
  });
});
