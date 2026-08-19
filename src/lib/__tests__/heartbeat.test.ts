/**
 * OPE-246 — the pure first-evidence silence decision. Mirrors
 * integration-silence.test (OPE-243), the pattern this extends.
 */
import { describe, it, expect } from "vitest";
import {
  assessHeartbeatSilence,
  HEARTBEAT_PROBES,
  type HeartbeatActivity,
  type HeartbeatProbe,
} from "@/lib/heartbeat";

const NOW = new Date("2026-07-20T00:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const probe = (over: Partial<HeartbeatProbe> = {}): HeartbeatProbe => ({
  name: "photo-intake",
  ownerOpe: "OPE-202",
  label: "Photo-intake lane",
  priority: "P1",
  expectedWindowHours: 72,
  lastEvidenceAt: async () => null,
  ...over,
});

const activity = (over: Partial<HeartbeatActivity> = {}): HeartbeatActivity => ({
  probe: probe(over.probe),
  enabledAt: hoursAgo(1000),
  lastEvidenceAt: hoursAgo(10), // recent
  ...over,
});

describe("assessHeartbeatSilence", () => {
  it("a DORMANT probe (enabledAt null) never fires — gated-off is not silence", () => {
    expect(
      assessHeartbeatSilence(activity({ enabledAt: null, lastEvidenceAt: null }), NOW)
    ).toBeNull();
  });

  it("recent evidence within the window → healthy (null)", () => {
    expect(assessHeartbeatSilence(activity({ lastEvidenceAt: hoursAgo(10) }), NOW)).toBeNull();
  });

  it("evidence STOPPED (last row older than the window) → RED", () => {
    const red = assessHeartbeatSilence(activity({ lastEvidenceAt: hoursAgo(200) }), NOW);
    expect(red).not.toBeNull();
    expect(red!.priority).toBe("P1");
    expect(red!.refKey).toBe("heartbeat:photo-intake");
    expect(red!.title).toContain("Photo-intake lane");
    expect(red!.title).toContain("OPE-202");
    expect(red!.hoursInRed).toBeCloseTo(200, 0);
  });

  it("never produced but still inside the window since enablement → null", () => {
    expect(
      assessHeartbeatSilence(activity({ lastEvidenceAt: null, enabledAt: hoursAgo(48) }), NOW)
    ).toBeNull();
  });

  it("never produced AND past the window since enablement → RED with the never-produced note", () => {
    const red = assessHeartbeatSilence(
      activity({ lastEvidenceAt: null, enabledAt: hoursAgo(200) }),
      NOW
    );
    expect(red).not.toBeNull();
    expect(red!.title).toContain("no evidence on record since enablement");
  });

  it("respects each probe's own window (a 30d-window probe tolerates a 10d gap)", () => {
    const p = probe({ expectedWindowHours: 30 * 24 });
    expect(
      assessHeartbeatSilence(activity({ probe: p, lastEvidenceAt: hoursAgo(10 * 24) }), NOW)
    ).toBeNull();
  });
});

describe("HEARTBEAT_PROBES registry", () => {
  it("seeds ≥8 probes with unique names and an owner OPE each", () => {
    expect(HEARTBEAT_PROBES.length).toBeGreaterThanOrEqual(8);
    const names = HEARTBEAT_PROBES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of HEARTBEAT_PROBES) {
      expect(p.ownerOpe).toMatch(/^OPE-/);
      expect(p.expectedWindowHours).toBeGreaterThan(0);
    }
  });
});

/**
 * OPE-309 — the assurance-audit probes, and the one I declined.
 *
 * The audit asked for four; three are periodic feeds and one (the fault
 * emitter) is event-driven. A freshness probe on an event-driven signal cannot
 * distinguish "nothing broke" from "the emitter died" — that is precisely the
 * false-STALE pattern OPE-295 removed from sitemap_quality, and re-adding it
 * here would have undone that lesson one ticket later.
 */
describe("OPE-309 assurance probes", () => {
  const names = HEARTBEAT_PROBES.map((p) => p.name);

  it("registers the three periodic cron-output feeds", () => {
    expect(names).toContain("gsc-search-metrics-ingest");
    expect(names).toContain("ga4-daily-metrics-ingest");
    expect(names).toContain("recommendation-scan");
  });

  it("probes the fault emitter's RUN, and never the fault LEDGER", () => {
    // The original form of this test asserted no probe name contained "fault" at
    // all. The PRINCIPLE it protects is sound and unchanged: `fault_signatures`
    // is EVENT-driven, so its `last_seen` stays flat during genuinely quiet
    // traffic and a freshness SLA on it rebuilds the false-STALE pattern OPE-295
    // removed. Absence of faults is not a dead feed.
    //
    // OPE-488 sharpened the assertion to the principle rather than to the
    // substring. The emitter writes one `mcp:fault-signatures-emit` row per RUN,
    // hourly, WHETHER OR NOT it finds anything — that signal is schedule-driven,
    // so absence there genuinely is evidence, and it is exactly what this file's
    // own rule says is probeable. Probe the run, never the yield.
    //
    // Worth the sharpening: on 2026-08-19 the ledger had not moved in ~50h and
    // two tickets were filed asserting the emitter had died. It was running every
    // hour on schedule; the ledger was quiet because ChunkLoadError is on the
    // curated NOISE_DENYLIST by design.
    //
    // Pinned to an exact list, not a "some" check, so any FUTURE fault-named
    // probe — in particular one on the ledger — still fails here and has to
    // argue its case.
    expect(names.filter((n) => n.includes("fault"))).toEqual(["fault-emitter-run"]);
  });

  it("sizes the fault-emitter probe for an HOURLY cadence, not a daily one", () => {
    const probe = HEARTBEAT_PROBES.find((p) => p.name === "fault-emitter-run")!;
    // Hourly cron: a window of a few hours tolerates a couple of missed fires
    // while still catching a genuinely dead emitter the same day. The 48h daily
    // sizing below would hide a full day of silence on an hourly feed.
    expect(probe.expectedWindowHours).toBeGreaterThanOrEqual(3);
    expect(probe.expectedWindowHours).toBeLessThanOrEqual(12);
  });

  it("gives the daily feeds room for exactly one missed run", () => {
    // 06:00Z daily cadence: a 48h window tolerates one skipped run and catches
    // a genuinely dead feed the next morning. Tighter than 24h would fire on a
    // single hiccup; much looser would hide a real outage for days.
    for (const name of ["gsc-search-metrics-ingest", "ga4-daily-metrics-ingest"]) {
      const probe = HEARTBEAT_PROBES.find((p) => p.name === name)!;
      expect(probe.expectedWindowHours).toBeGreaterThan(24);
      expect(probe.expectedWindowHours).toBeLessThanOrEqual(72);
      // Both back KPI tiles, so a silent stop shows a stale number indefinitely.
      expect(probe.priority).toBe("P0");
    }
  });
});
