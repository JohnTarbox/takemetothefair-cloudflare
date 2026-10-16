import { describe, expect, it } from "vitest";
import {
  isStreetAddressHidden,
  publicStreetAddress,
  withPublicStreetAddress,
} from "./vendor-public-address";

const STREET = "12 Hidden Lane Apt 3";

describe("OPE-1398 vendor street-address rule", () => {
  it("hides a self-signup vendor's street address by default", () => {
    const v = { address: STREET, selfSignup: true, showStreetAddress: false, city: "Fryeburg" };
    expect(isStreetAddressHidden(v)).toBe(true);
    expect(publicStreetAddress(v)).toBeNull();
    const out = withPublicStreetAddress(v);
    expect(out.address).toBeNull();
    expect(out.hasStreetAddress).toBe(true);
    // city stays
    expect(out.city).toBe("Fryeburg");
    expect(JSON.stringify(out)).not.toContain("Hidden Lane");
  });

  it("treats D1 integer booleans the same as booleans", () => {
    expect(
      publicStreetAddress({ address: STREET, selfSignup: 1, showStreetAddress: 0 })
    ).toBeNull();
    expect(publicStreetAddress({ address: STREET, selfSignup: 1, showStreetAddress: 1 })).toBe(
      STREET
    );
  });

  it("shows it when the self-signup vendor opted back in", () => {
    const v = { address: STREET, selfSignup: true, showStreetAddress: true };
    expect(isStreetAddressHidden(v)).toBe(false);
    expect(withPublicStreetAddress(v).address).toBe(STREET);
  });

  it("leaves admin/import-created vendors unchanged", () => {
    for (const selfSignup of [false, null, undefined]) {
      const v = { address: "99 Fairground Rd", selfSignup, showStreetAddress: false };
      expect(publicStreetAddress(v)).toBe("99 Fairground Rd");
    }
  });

  it("hasStreetAddress is false when nothing is on file", () => {
    expect(withPublicStreetAddress({ address: "  ", selfSignup: true }).hasStreetAddress).toBe(
      false
    );
    expect(withPublicStreetAddress({ address: null }).hasStreetAddress).toBe(false);
  });
});
