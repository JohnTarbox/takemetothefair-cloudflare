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

/**
 * OPE-944 — the original-sender forward-analysis probe.
 *
 * Added after the fact: #1245 shipped the writer without its probe, against
 * CLAUDE.md's OPE-246 rule ("treat the probe as part of the ship, not a
 * follow-up"). These tests pin the two decisions that make it a real control
 * rather than a probe-shaped entry.
 */
describe("OPE-944 inbound-forward-analysis probe", () => {
  const probe = HEARTBEAT_PROBES.find((p) => p.name === "inbound-forward-analysis")!;

  it("is registered, owned, and P1", () => {
    expect(probe).toBeDefined();
    expect(probe.ownerOpe).toBe("OPE-944");
    expect(probe.priority).toBe("P1");
  });

  it("uses the MEASURED 72h window, not the 21d inbound-submit window", () => {
    // 4x the worst observed inter-arrival gap (18.0h across 195 rows / 22 days).
    // Pinned so a later edit has to argue with the measurement rather than
    // quietly widening it — the OPE-830 failure was a window nobody could trace
    // back to a number.
    expect(probe.expectedWindowHours).toBe(72);
    // And it is genuinely tighter than the sibling probe on the same table, so
    // this is not just inheriting a neighbour's setting.
    const submit = HEARTBEAT_PROBES.find((p) => p.name === "inbound-submit")!;
    expect(probe.expectedWindowHours).toBeLessThan(submit.expectedWindowHours);
  });

  it("probes the RUN — evidence is the verdict column, never a recovered .eml", () => {
    // This file's own rule (OPE-488): probe the run, never the yield. A probe
    // keyed on an .eml actually being recovered would depend on a human
    // choosing "Forward as attachment" — zero occurrences in the whole archive
    // as of 2026-09-11 — so it would fire forever and get muted.
    //
    // Asserted against the registry rather than the query text so it stays true
    // if the implementation is refactored: no probe may key on the rfc822
    // recovery itself.
    const names = HEARTBEAT_PROBES.map((p) => p.name);
    expect(names.filter((n) => /rfc822|eml|attachment-forward/.test(n))).toEqual([]);
    expect(names).toContain("inbound-forward-analysis");
  });

  // ── v3.8: the probe driven to failure, at its real boundary ──────────────
  //
  // A registry entry with a plausible number in it is not yet a control. These
  // two run the REAL probe object through the REAL decision function and pin
  // both sides of the 72h line, so "this probe would catch the outage" is a
  // measurement rather than a claim.

  it("STAYS QUIET through the worst gap ever observed (18h) — it cannot cry wolf", () => {
    expect(
      assessHeartbeatSilence(
        { probe, enabledAt: hoursAgo(1000), lastEvidenceAt: hoursAgo(18) },
        NOW
      )
    ).toBeNull();
    // And with real headroom: even 3x the worst observed gap is still quiet.
    expect(
      assessHeartbeatSilence(
        { probe, enabledAt: hoursAgo(1000), lastEvidenceAt: hoursAgo(54) },
        NOW
      )
    ).toBeNull();
  });

  it("GOES RED once the verdict column stops being written — the outage it exists for", () => {
    // The real failure shape: analyzeForward throws, the handler's fail-soft
    // catch logs a warn, ingestion continues looking perfectly healthy, and
    // original_sender_auth silently goes NULL on every new row.
    const red = assessHeartbeatSilence(
      { probe, enabledAt: hoursAgo(1000), lastEvidenceAt: hoursAgo(80) },
      NOW
    );
    expect(red).not.toBeNull();
    expect(red!.priority).toBe("P1");
    expect(red!.refKey).toBe("heartbeat:inbound-forward-analysis");
    expect(red!.title).toContain("OPE-944");
  });

  it("FILTERS on original_sender_auth — without it the probe is vacuous", () => {
    // ⚠️ This test exists because the mutation was NOT caught. Deleting the
    // `isNotNull(inboundEmails.originalSenderAuth)` filter left every other
    // test in this file GREEN — and a probe without it watches "did any inbound
    // email arrive", which is always true. It could never detect the forward
    // analysis dying, while reading as coverage.
    //
    // That is the amendment-H shape this file already documents for OPE-865:
    // a control whose population is WIDER than the condition it claims to
    // watch. It is not inert — it runs, and it answers a different question.
    //
    // So the evidence QUERY is pinned, not just the window. A fake db captures
    // the WHERE clause and the column it names; dropping the filter makes that
    // argument `undefined` and turns this red.
    const captured = captureProbeWhere(probe);
    expect(captured.called).toBe(true);
    expect(captured.where).toBeDefined();
    expect(captured.columns).toEqual(["original_sender_auth"]);
  });
});

/**
 * Run a probe's `lastEvidenceAt` against a stub db and report the WHERE clause
 * it built, plus the schema columns that clause names.
 *
 * Deliberately inspects the generated SQL rather than hitting a database: the
 * claim under test is "this probe filters on the right column", and a db round
 * trip would answer "these rows came back", which is a different question and
 * would pass against an unfiltered query whenever the fixture happened to have
 * the column set.
 */
function captureProbeWhere(p: HeartbeatProbe): {
  called: boolean;
  where: unknown;
  columns: string[];
} {
  let called = false;
  let where: unknown;
  const fake = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          called = true;
          where = w;
          return [{ t: null }];
        },
      }),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void p.lastEvidenceAt(fake as any);

  const columns: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any, depth = 0): void => {
    if (!n || depth > 6 || typeof n !== "object") return;
    if (typeof n.name === "string" && n.columnType) columns.push(n.name);
    for (const key of ["queryChunks", "left", "right", "value"]) {
      const child = n[key];
      if (!child) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (Array.isArray(child)) child.forEach((c: any) => walk(c, depth + 1));
      else walk(child, depth + 1);
    }
  };
  walk(where);
  return { called, where, columns };
}
