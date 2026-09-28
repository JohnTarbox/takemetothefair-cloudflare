/**
 * OPE-1180 — EDTF bounds, lifecycle validation, and the FORMER-venue date guard.
 */
import { describe, expect, it } from "vitest";
import { checkFormerVenue, parseEdtfBounds, validateVenueLifecycle } from "../former-venue";

const iso = (d: Date | undefined) => d?.toISOString();

describe("parseEdtfBounds", () => {
  it.each([
    ["1881", "1881-01-01T00:00:00.000Z", "1881-12-31T23:59:59.000Z", false],
    ["1881-10", "1881-10-01T00:00:00.000Z", "1881-10-31T23:59:59.000Z", false],
    ["1881-10-14", "1881-10-14T00:00:00.000Z", "1881-10-14T23:59:59.000Z", false],
    ["195X", "1950-01-01T00:00:00.000Z", "1959-12-31T23:59:59.000Z", false],
    ["19XX", "1900-01-01T00:00:00.000Z", "1999-12-31T23:59:59.000Z", false],
    ["1956-XX", "1956-01-01T00:00:00.000Z", "1956-12-31T23:59:59.000Z", false],
    // Qualified: widened one year each side.
    ["1956~", "1955-01-01T00:00:00.000Z", "1957-12-31T23:59:59.000Z", true],
    ["1956?", "1955-01-01T00:00:00.000Z", "1957-12-31T23:59:59.000Z", true],
    ["1956%", "1955-01-01T00:00:00.000Z", "1957-12-31T23:59:59.000Z", true],
    ["2024-02", "2024-02-01T00:00:00.000Z", "2024-02-29T23:59:59.000Z", false],
  ])("%s → [%s, %s]", (input, lo, hi, qualified) => {
    const b = parseEdtfBounds(input);
    expect(iso(b?.earliest)).toBe(lo);
    expect(iso(b?.latest)).toBe(hi);
    expect(b?.qualified).toBe(qualified);
  });

  it.each(["", "18", "1881-13", "1881-02-30", "1881/1890", "circa 1881", "1956-XX-14", "abcd"])(
    "refuses %j",
    (input) => expect(parseEdtfBounds(input)).toBeNull()
  );
});

describe("validateVenueLifecycle", () => {
  it("FORMER without use_ended_edtf is refused", () => {
    const r = validateVenueLifecycle({ status: "FORMER" });
    expect(r.ok).toBe(false);
  });

  it("FORMER with an end date derives the closure bounds", () => {
    const r = validateVenueLifecycle({
      status: "FORMER",
      useStartedEdtf: "1866",
      useEndedEdtf: "1881~",
    });
    expect(r.ok && iso(r.derived.useEndedEarliest ?? undefined)).toBe("1880-01-01T00:00:00.000Z");
    expect(r.ok && iso(r.derived.useEndedLatest ?? undefined)).toBe("1882-12-31T23:59:59.000Z");
  });

  it("an unparseable EDTF is refused on ANY status", () => {
    expect(validateVenueLifecycle({ status: "ACTIVE", useEndedEdtf: "sometime" }).ok).toBe(false);
  });

  it("an end before the start is refused", () => {
    expect(
      validateVenueLifecycle({ status: "FORMER", useStartedEdtf: "1900", useEndedEdtf: "1890" }).ok
    ).toBe(false);
  });

  it("ACTIVE with no lifecycle fields is unchanged behaviour", () => {
    expect(validateVenueLifecycle({ status: "ACTIVE" })).toEqual({
      ok: true,
      derived: { useEndedEarliest: null, useEndedLatest: null },
    });
  });
});

describe("checkFormerVenue — the three outcomes", () => {
  const b = parseEdtfBounds("1881~")!; // [1880-01-01, 1882-12-31]
  const montpelier = {
    id: "v-montpelier",
    name: "Montpelier Trotting Park",
    status: "FORMER",
    useEndedEdtf: "1881~",
    useEndedEarliest: b.earliest,
    useEndedLatest: b.latest,
  };
  const at = (d: string) => new Date(`${d}T12:00:00Z`);

  it("an event before the closure window is allowed (a real past fair)", () => {
    expect(checkFormerVenue(montpelier, at("1879-09-20"))).toEqual({ kind: "allow" });
  });

  it("an event inside the closure window is allowed but flagged", () => {
    expect(checkFormerVenue(montpelier, at("1881-09-20")).kind).toBe("flag");
  });

  it("an event after the closure is refused, and the message names the closure", () => {
    const v = checkFormerVenue(montpelier, at("2026-09-27"));
    expect(v.kind).toBe("refuse");
    expect(v.kind === "refuse" && v.message).toContain("closed 1881~");
    expect(v.kind === "refuse" && v.message).toContain("2026-09-27");
  });

  it("an undated event at a FORMER venue is flagged, not silently allowed", () => {
    expect(checkFormerVenue(montpelier, null).kind).toBe("flag");
  });

  it("ACTIVE and INACTIVE venues are never judged", () => {
    expect(checkFormerVenue({ ...montpelier, status: "ACTIVE" }, at("2026-09-27"))).toEqual({
      kind: "allow",
    });
    expect(checkFormerVenue({ ...montpelier, status: "INACTIVE" }, at("2026-09-27"))).toEqual({
      kind: "allow",
    });
    expect(checkFormerVenue(null, at("2026-09-27"))).toEqual({ kind: "allow" });
  });

  it("a FORMER row with no bounds fails closed for a dated event", () => {
    const broken = { ...montpelier, useEndedEarliest: null, useEndedLatest: null };
    expect(checkFormerVenue(broken, at("1850-01-01")).kind).toBe("refuse");
  });
});
