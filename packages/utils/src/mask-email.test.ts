import { describe, it, expect } from "vitest";
import { maskEmail, maskEmails } from "./mask-email";

describe("maskEmail (OPE-1379)", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("john.doe@example.com")).toBe("j***@example.com");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
  });

  it("trims, and extracts the address from a display form (dropping the name)", () => {
    expect(maskEmail("  jane@example.org ")).toBe("j***@example.org");
    expect(maskEmail('"Jane Doe" <jane.doe@example.org>')).toBe("j***@example.org");
  });

  it("uses the LAST @ so a quoted local part cannot push the domain into view", () => {
    expect(maskEmail('"odd@local"@example.net')).toBe('"***@example.net');
  });

  it("never passes a malformed value through unmasked", () => {
    for (const v of ["", "   ", "no-at-sign", "@example.com", "user@", null, undefined]) {
      expect(maskEmail(v as string)).toBe("***");
    }
  });

  it("output never contains the original local part beyond its first character", () => {
    const out = maskEmail("secretname@example.com");
    expect(out).not.toContain("secretname");
    expect(out.endsWith("@example.com")).toBe(true);
  });
});

describe("maskEmails (OPE-1379)", () => {
  it("masks a single address, a comma/semicolon list, and an array", () => {
    expect(maskEmails("john@example.com")).toBe("j***@example.com");
    expect(maskEmails("john@example.com, mary@example.org;pat@x.io")).toBe(
      "j***@example.com, m***@example.org, p***@x.io"
    );
    expect(maskEmails(["john@example.com", "mary@example.org"])).toBe(
      "j***@example.com, m***@example.org"
    );
  });

  it("returns *** for nothing usable", () => {
    expect(maskEmails(null)).toBe("***");
    expect(maskEmails(undefined)).toBe("***");
    expect(maskEmails("")).toBe("***");
    expect(maskEmails([])).toBe("***");
  });
});
