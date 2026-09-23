/**
 * OPE-325 — the poster-evidence probe is DEMAND-conditional: posters are bursty
 * (4 staged 08-24 → 08-27, then none for 27 days), so a plain "newest evidence"
 * probe would read a quiet month as a dead path.
 */
import { describe, it, expect } from "vitest";
import { demandConditionalEvidence, HEARTBEAT_PROBES } from "@/lib/heartbeat";

const now = new Date("2026-09-23T18:00:00Z");
const at = (s: string) => new Date(s);

describe("demandConditionalEvidence", () => {
  it("no poster has ever resolved → healthy (nothing is owed)", () => {
    expect(demandConditionalEvidence(null, null, now)).toBe(now);
    // Old evidence with no demand is NOT a month of silence.
    expect(demandConditionalEvidence(null, at("2026-08-27T23:02:12Z"), now)).toBe(now);
  });

  it("the last poster WAS followed by evidence → healthy, however long ago", () => {
    expect(
      demandConditionalEvidence(at("2026-08-27T23:02:10Z"), at("2026-08-27T23:02:12Z"), now)
    ).toBe(now);
  });

  it("a poster resolved and NO evidence followed → the clock starts at that poster", () => {
    const d = at("2026-09-23T09:00:00Z");
    expect(demandConditionalEvidence(d, at("2026-08-27T23:02:12Z"), now)).toBe(d);
    expect(demandConditionalEvidence(d, null, now)).toBe(d);
  });
});

describe("the probe is registered", () => {
  it("poster-evidence is in HEARTBEAT_PROBES, owned by OPE-325", () => {
    const p = HEARTBEAT_PROBES.find((x) => x.name === "poster-evidence");
    expect(p).toMatchObject({ ownerOpe: "OPE-325", expectedWindowHours: 24 });
  });
});
