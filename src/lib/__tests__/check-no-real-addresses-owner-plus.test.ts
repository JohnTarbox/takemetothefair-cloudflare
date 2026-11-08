/** OPE-1583 — a plus-tag of John's address is his; anyone else's still fails. */
import { describe, expect, it } from "vitest";
import { scanText } from "../../../scripts/check-no-real-addresses";

// Assembled at runtime so these negative fixtures aren't flagged by the scan of
// this file. They are invented addresses.
const at = (local: string, domain: string) => `${local}@${domain}`;

describe("check-no-real-addresses plus-tags", () => {
  it("allows a plus-tag of the owner's address, and the LIKE pattern for them", () => {
    expect(scanText("f", "jtarboxme+ope1145v@gmail.com")).toEqual([]);
    expect(scanText("f", '"jtarboxme+%@gmail.com"')).toEqual([]);
  });

  it("still flags a stranger's plain and plus-tagged address", () => {
    expect(scanText("f", at("jane.q.citizen", "gmail.com"))).toHaveLength(1);
    expect(scanText("f", at("jane.q.citizen+news", "gmail.com"))).toHaveLength(1);
  });

  it("does not let a plus-tag on another domain pass as the owner", () => {
    expect(scanText("f", at("jtarboxme+x", "yahoo.com"))).toHaveLength(1);
  });
});
