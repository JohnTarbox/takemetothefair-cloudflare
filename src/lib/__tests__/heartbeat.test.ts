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
