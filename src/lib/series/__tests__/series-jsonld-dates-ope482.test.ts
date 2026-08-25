/**
 * OPE-482 follow-up — the series JSON-LD builder must agree with the event one.
 *
 * OPE-482 moved date rendering to Eastern and fixed `EventSchema.tsx`. It missed
 * the SERIES builder, which derives its `startDate`/`endDate` strings separately
 * via `toISOString().slice(0, 10)`. The result was two Google-visible schemas for
 * the same fair disagreeing by a day: `/events/oxford-fair/2026` emitted the
 * correct span while `/events/farmington-fair` emitted `"endDate":"2026-09-27"`
 * for a fair that ends Sep 26.
 *
 * `EventSchema.tsx` carries the standing warning — "If you ever change one,
 * change both and update docs/SCHEMA_ORG.md" — about the eventStatus mapping.
 * It applies to the date derivation too, and a comment did not stop the
 * divergence. This does.
 */
import { describe, it, expect } from "vitest";
import { toSchemaOccurrences } from "../occurrence-view";
import { toIsoDateOnlyInVenueZone } from "@/lib/datetime";

/** The real farmington-fair row: end-of-day Eastern on Sep 26. */
const FARMINGTON_END = new Date("2026-09-27T03:59:59.000Z");
const FARMINGTON_START = new Date("2026-09-20T12:00:00.000Z");

function occ(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    slug: "farmington-fair",
    name: "Farmington Fair",
    startDate: FARMINGTON_START,
    endDate: FARMINGTON_END,
    venue: null,
    imageUrl: null,
    lifecycleStatus: null,
    ...overrides,
  } as never;
}

describe("series JSON-LD dates are Eastern calendar dates", () => {
  it("an end-of-day-Eastern occurrence does not spill into the next day", () => {
    // The whole defect in one assertion: the UTC slice of this instant is
    // "2026-09-27", and the fair ends on the 26th.
    expect(FARMINGTON_END.toISOString().slice(0, 10)).toBe("2026-09-27");

    const [node] = toSchemaOccurrences([occ()]);
    expect(node.endDateIso).toBe("2026-09-26");
    expect(node.startDateIso).toBe("2026-09-20");
  });

  it("the noon anchor — the dominant convention — is unaffected", () => {
    const [node] = toSchemaOccurrences([
      occ({
        startDate: new Date("2026-09-20T12:00:00Z"),
        endDate: new Date("2026-09-26T12:00:00Z"),
      }),
    ]);
    expect(node.startDateIso).toBe("2026-09-20");
    expect(node.endDateIso).toBe("2026-09-26");
  });

  it("a null date stays null rather than becoming a string", () => {
    // A dateless occurrence node is dropped by the builder (OPE-32); it must
    // reach it as null, not as "" or "1970-01-01".
    const [node] = toSchemaOccurrences([occ({ startDate: null, endDate: null })]);
    expect(node.startDateIso).toBeNull();
    expect(node.endDateIso).toBeNull();
  });

  it("uses the same helper the event builder does — not a second implementation", () => {
    // The divergence existed because each builder derived the string its own
    // way. Pinning them to one helper is the fix; this asserts they agree.
    const [node] = toSchemaOccurrences([occ()]);
    expect(node.endDateIso).toBe(toIsoDateOnlyInVenueZone(FARMINGTON_END));
  });
});
