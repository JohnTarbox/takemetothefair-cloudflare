/**
 * OPE-1061 — the pet_friendly rules, pinned where every reader and writer
 * shares them. The field fails by stranding someone at a gate, so each
 * constraint gets its own assertion.
 */
import { describe, expect, it } from "vitest";
import {
  PET_FRIENDLY_VALUES,
  petFriendlyWriteError,
  petPolicyDisplay,
  venuePetPolicyDisplay,
} from "../pet-policy";

const EV = {
  source_url: "https://organizer.example/faq",
  source_type: "official_website" as const,
};

describe("petFriendlyWriteError — citation or it does not ship", () => {
  it("UNSET needs nothing (a reset)", () => {
    expect(petFriendlyWriteError("UNSET", null)).toBeNull();
  });

  it.each(["YES", "NO"] as const)("%s needs a source AND a verbatim excerpt", (v) => {
    expect(petFriendlyWriteError(v, null)).toMatch(/verbatim excerpt/);
    expect(petFriendlyWriteError(v, EV)).toMatch(/excerpt/);
    expect(petFriendlyWriteError(v, { ...EV, excerpt: "   " })).toMatch(/excerpt/);
    expect(petFriendlyWriteError(v, { ...EV, excerpt: "Dogs welcome on leash." })).toBeNull();
  });

  it("NOT_PUBLISHED needs the page checked and what was checked", () => {
    expect(petFriendlyWriteError("NOT_PUBLISHED", null)).toMatch(/checked/);
    expect(petFriendlyWriteError("NOT_PUBLISHED", EV)).toMatch(/checked/);
    expect(
      petFriendlyWriteError("NOT_PUBLISHED", { ...EV, checked: "FAQ, rules page" })
    ).toBeNull();
  });
});

describe("petPolicyDisplay — what a page may say", () => {
  it("UNSET and NOT_PUBLISHED render as ABSENT, never as No", () => {
    expect(petPolicyDisplay("UNSET")).toBeNull();
    expect(petPolicyDisplay("NOT_PUBLISHED")).toBeNull();
    expect(petPolicyDisplay(null)).toBeNull();
    expect(petPolicyDisplay(undefined)).toBeNull();
  });

  it("NO carries the service-animal exception — never a bare negative", () => {
    for (const d of [petPolicyDisplay("NO"), venuePetPolicyDisplay("NO")]) {
      expect(d?.label).toMatch(/service animals/i);
      expect(d?.label.trim().toLowerCase()).not.toBe("no");
    }
  });

  it("the venue line is labelled as the venue's", () => {
    expect(venuePetPolicyDisplay("YES")?.label).toMatch(/venue/i);
    expect(venuePetPolicyDisplay("NO")?.label).toMatch(/venue/i);
  });

  it("every state is handled — a new value must be decided, not defaulted", () => {
    // Landmark: four states exist, and exactly two render.
    expect(PET_FRIENDLY_VALUES).toHaveLength(4);
    expect(PET_FRIENDLY_VALUES.filter((v) => petPolicyDisplay(v) !== null)).toEqual(["YES", "NO"]);
  });

  it("takes ONE value — there is no venue input to inherit from", () => {
    // Constraint 1 enforced by shape: the event display cannot be composed from
    // a venue value because it has nowhere to receive one.
    expect(petPolicyDisplay.length).toBe(1);
  });
});
