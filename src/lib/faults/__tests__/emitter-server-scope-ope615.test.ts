/**
 * OPE-615 — the emitter's SCOPE, not its liveness.
 *
 * OPE-488 answered "is the emitter running?" — it was. This is about what it is
 * pointed at. It scanned `source IN ('server-render','client')`, so every route
 * handler, scheduled job, workflow and queue consumer could recur for weeks and
 * never mint a signature.
 *
 * Measured on prod over 7 days: 209 rows in scope against 134 rows across 16
 * EXCLUDED sources — and the two largest excluded ones were the two live
 * defects, `app/events/page.tsx:getEvents` (88) and
 * `api/admin/import-url/extract` (26, OPE-576).
 *
 * Four consecutive OPE-84 runs found every fileable fault in the out-of-ledger
 * sweep and none in the ledger. The failure is SELF-CERTIFYING: the scan
 * reports a clean ledger and a human reasonably reads that as a clean
 * production.
 *
 * These test the two pure decisions the widening turns on — the grouping key
 * and the session dimension. The route handler itself needs a live D1 binding;
 * what matters here is that server rows do not collapse together and that a
 * burst does not outrank a recurrence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeSignature } from "../signature";

/** Mirrors the route: render rows key on route, server rows key on source. */
const RENDER_LANE = ["server-render", "client"];
const groupKeyFor = (source: string | null, route: string | null) =>
  RENDER_LANE.includes(source ?? "") ? route : (source ?? route);

/** Mirrors the route: server rows use the UTC day as the session dimension. */
const sessionKeyFor = (source: string | null, tsMs: number, renderKey: string | null) =>
  RENDER_LANE.includes(source ?? "") ? renderKey : new Date(tsMs).toISOString().slice(0, 10);

const DAY = 86400_000;
const T0 = Date.parse("2026-08-28T12:00:00Z");

describe("OPE-615 — server faults must not collapse into one signature", () => {
  it("two different server sources with the SAME message are distinct faults", () => {
    // The failure this guards. `computeSignature` falls back to the literal
    // "unknown" when route is null, and route IS null on every server row — so
    // widening the scan without keying on source would collapse every backend
    // fault in the system into one row per error class.
    const msg = "D1_ERROR: LIKE or GLOB pattern too complex";
    const a = computeSignature({
      route: groupKeyFor("app/events/page.tsx:getEvents", null),
      message: msg,
      digest: null,
    });
    const b = computeSignature({
      route: groupKeyFor("api/vendor/self-reported-events", null),
      message: msg,
      digest: null,
    });
    expect(a).not.toBe(b);
    expect(a).toContain("app/events/page.tsx:getEvents");
    expect(b).toContain("api/vendor/self-reported-events");
  });

  it("neither collapses to the 'unknown' route bucket", () => {
    const sig = computeSignature({
      route: groupKeyFor("mcp:workflow:recommendations-scan", null),
      message: "exceeded execution ceiling",
      digest: null,
    });
    expect(sig.startsWith("unknown#")).toBe(false);
  });

  it("the render lane still keys on ROUTE, not on source", () => {
    // Widening must not silently re-key the lane that already worked — every
    // existing client signature would orphan and re-propose.
    const sig = computeSignature({
      route: groupKeyFor("client", "/events/cummington-fair/2026"),
      message: "TypeError: undefined is not an object",
      digest: null,
    });
    expect(sig).toContain("/events/cummington-fair/2026");
    expect(sig).not.toContain("client#");
  });

  it("the same source with DIFFERENT messages stays two faults", () => {
    const a = computeSignature({
      route: groupKeyFor("api/admin/import-url/extract", null),
      message: "Workers AI timeout after 20000ms",
      digest: null,
    });
    const b = computeSignature({
      route: groupKeyFor("api/admin/import-url/extract", null),
      message: "D1_ERROR: no such column",
      digest: null,
    });
    expect(a).not.toBe(b);
  });
});

describe("OPE-615 scope 2 — a recurrence must outrank a burst", () => {
  it("a 3-second burst on ONE day counts as a single session", () => {
    // The gate was tuned against burst-prone browser noise, and on server rows
    // there is no session key at all — so `distinctSessions` degraded to the
    // raw count and ranked a loop-burst ABOVE a standing fault.
    const burst = [T0, T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000];
    const sessions = new Set(burst.map((t) => sessionKeyFor("api/x", t, null)));
    expect(burst.length).toBe(5);
    expect(sessions.size).toBe(1);
  });

  it("a cron failing once a day for three days counts as three", () => {
    const daily = [T0, T0 + DAY, T0 + 2 * DAY];
    const sessions = new Set(daily.map((t) => sessionKeyFor("mcp:schedule:gsc-sweep", t, null)));
    expect(daily.length).toBe(3);
    expect(sessions.size).toBe(3);
  });

  it("the ranking is INVERTED relative to raw count — the point of the change", () => {
    // Burst: higher count, fewer sessions. Recurrence: lower count, more
    // sessions. Under `minSessions`, the recurrence now proposes and the burst
    // does not, which is the correct order.
    const burst = [T0, T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000];
    const daily = [T0, T0 + DAY, T0 + 2 * DAY];
    const burstSessions = new Set(burst.map((t) => sessionKeyFor("api/x", t, null))).size;
    const dailySessions = new Set(daily.map((t) => sessionKeyFor("api/x", t, null))).size;
    expect(burst.length).toBeGreaterThan(daily.length); // raw count says burst wins
    expect(dailySessions).toBeGreaterThan(burstSessions); // sessions say otherwise
  });

  it("render rows keep their own session key — the change is server-only", () => {
    expect(sessionKeyFor("client", T0, "sess-abc")).toBe("sess-abc");
    expect(sessionKeyFor("client", T0, null)).toBe(null);
  });
});

/**
 * The mirror above reproduces the route's DECISIONS so they can be tested as
 * pure functions. That is only worth anything if the route still implements
 * them — a mirror that drifts from its subject is the definition of a
 * decorative test.
 *
 * So: pin the shipped route to the same shape.
 */
describe("the route implements what the mirror models", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/internal/faults/candidates/route.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("no longer allow-lists the render sources in the scan", () => {
    // The defect, exactly: `inArray(errorLogs.source, RENDER_FAULT_SOURCES)`
    // meant a NEW source was ignored by default.
    expect(ROUTE).not.toMatch(/inArray\(\s*errorLogs\.source/);
  });

  it("scans by exclusion instead — so a new source is watched by default", () => {
    expect(ROUTE).toMatch(/notInArray\(\s*errorLogs\.source,\s*NEVER_INGEST_SOURCES/);
  });

  it("still refuses to ingest its own heartbeat (the OPE-93 lesson)", () => {
    // Without this the emitter grouped its own "I ran" stamp and re-ingested
    // itself. Widening the scan makes that live again unless excluded by name.
    expect(ROUTE).toMatch(/NEVER_INGEST_SOURCES\s*=\s*\[/);
    expect(ROUTE).toContain("EMIT_HEARTBEAT_SOURCE_NAME");
    expect(ROUTE).toContain('"faults:candidates"');
  });

  it("keys server rows on source and render rows on route", () => {
    expect(ROUTE).toMatch(/isRenderLane\s*\?\s*r\.route\s*:\s*\(r\.source/);
  });

  it("uses the UTC day as the server session dimension", () => {
    expect(ROUTE).toMatch(/toISOString\(\)\.slice\(0,\s*10\)/);
  });
});
