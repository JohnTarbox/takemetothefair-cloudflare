/**
 * OPE-1112 — the SCHEMA refuses a page URL in an image column.
 *
 * `image-url.test.ts` pins the predicate. This pins that the predicate is
 * actually WIRED, which is a different claim and the one that failed here:
 * `checkImageUrl` could be perfect and `logoUrl: urlSchema` would still accept
 * `https://www.facebook.com/profile.php?id=…`, exactly as it did for the three
 * weeks Margaret's logo was a blank square.
 *
 * Both vendor schemas are covered because `vendorUpdateSchema` derives from
 * `vendorCreateSchema` via `.partial()` — a wiring that holds for one and not
 * the other is the "fix wired into 1 of 2 parallel paths" shape.
 */
import { describe, it, expect } from "vitest";
import { vendorProfileUpdateSchema, vendorCreateSchema, vendorUpdateSchema } from "./index";

const MARGES_URL = "https://www.facebook.com/profile.php?id=61568647635851";
const REAL_LOGO = "https://cdn.shopify.com/s/files/1/0703/files/Hangtag.jpg?v=1786546389";

describe("OPE-1112 — vendorProfileUpdateSchema (the self-service form)", () => {
  it("ACCEPTANCE: rejects the exact URL that was in prod", () => {
    const result = vendorProfileUpdateSchema.safeParse({ logoUrl: MARGES_URL });
    expect(result.success).toBe(false);
  });

  it("the error names the problem, so the vendor can act on it", () => {
    const result = vendorProfileUpdateSchema.safeParse({ logoUrl: MARGES_URL });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("a Facebook page");
    expect(message).toContain("Upload your logo");
  });

  it("LANDMARK: a real cache-busted logo still saves", () => {
    // Without this the suite passes with `logoUrl: z.never()`, which would
    // lock 106 vendors out of a field that works for them today.
    const result = vendorProfileUpdateSchema.safeParse({ logoUrl: REAL_LOGO });
    expect(result.success).toBe(true);
  });

  it("clearing the logo is still allowed", () => {
    expect(vendorProfileUpdateSchema.safeParse({ logoUrl: "" }).success).toBe(true);
    expect(vendorProfileUpdateSchema.safeParse({ logoUrl: null }).success).toBe(true);
  });

  it("`website` is deliberately NOT image-validated — a website IS a page", () => {
    // The rule must apply to image columns only. Tightening `website` would
    // reject every vendor's actual homepage, which is the correct value there.
    const result = vendorProfileUpdateSchema.safeParse({
      website: "https://www.facebook.com/douseskin/",
    });
    expect(result.success).toBe(true);
  });
});

describe("OPE-1112 — the admin schemas, which derive from one another", () => {
  it("vendorCreateSchema rejects it", () => {
    const result = vendorCreateSchema.safeParse({
      userId: "3f0a5c1e-9b2d-4a7f-8c31-2b6de4f09a11",
      businessName: "Test Vendor",
      logoUrl: MARGES_URL,
    });
    expect(result.success).toBe(false);
  });

  it("vendorUpdateSchema rejects it too — .partial() must not drop the refine", () => {
    const result = vendorUpdateSchema.safeParse({ logoUrl: MARGES_URL });
    expect(result.success).toBe(false);
  });

  it("…and both still accept a real logo", () => {
    expect(vendorUpdateSchema.safeParse({ logoUrl: REAL_LOGO }).success).toBe(true);
  });
});
