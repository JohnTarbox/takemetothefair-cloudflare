/**
 * OPE-866 (09-23 bounce) — the ledger alone must tell a test send from a
 * broadcast, per audience. Prod: the 09-09 vendor pair (02:02 preview, 02:05
 * broadcast) was identical on every column but time and recipient.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  newsletterLedgerSource,
  NEWSLETTER_SOURCE,
  VENDOR_DIGEST_SOURCE,
} from "../newsletter-broadcast";

describe("newsletterLedgerSource", () => {
  it("broadcast and test differ, per audience, and both stay under newsletter:%", () => {
    expect(newsletterLedgerSource("vendor", "broadcast")).toBe(VENDOR_DIGEST_SOURCE);
    expect(newsletterLedgerSource("vendor", "test")).toBe(`${VENDOR_DIGEST_SOURCE}:test`);
    expect(newsletterLedgerSource("weekend", "broadcast")).toBe(NEWSLETTER_SOURCE);
    expect(newsletterLedgerSource("weekend", "test")).toBe(`${NEWSLETTER_SOURCE}:test`);
    for (const a of ["vendor", "weekend"] as const)
      for (const m of ["broadcast", "test"] as const)
        expect(newsletterLedgerSource(a, m)).toMatch(/^newsletter:/);
  });
});

describe("every send route decides the source through it", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the manual send route marks a test_recipient send", () => {
    expect(read("src/app/api/admin/newsletter/send/route.ts")).toMatch(
      /source: newsletterLedgerSource\(audience, isBroadcast \? "broadcast" : "test"\)/
    );
  });
  it("the vendor-digest test path marks its send", () => {
    expect(read("src/app/api/admin/newsletter/vendor-digest/route.ts")).toMatch(
      /source: newsletterLedgerSource\("vendor", "test"\)/
    );
  });
});
