/**
 * OPE-1368 — `urlSchema` accepts only http(s).
 *
 * It was `z.string().url()`, which is "does `new URL()` parse it": on zod
 * 4.6.5 `javascript:alert(1)//` and `data:text/html,…` both passed, a vendor
 * could self-edit `website`, and the value rendered raw as an `href`.
 *
 * Covered through the real schemas (not a re-implementation) on every surface
 * that writes a rendered URL, so a fix wired into one and not another fails.
 */
import { describe, it, expect } from "vitest";
import {
  vendorProfileUpdateSchema,
  vendorUpdateSchema,
  promoterUpdateSchema,
  venueUpdateSchema,
  eventUpdateSchema,
  promoterEventCreateSchema,
  userProfileUpdateSchema,
} from "./index";

const DANGEROUS = [
  "javascript:alert(1)//",
  "JavaScript:alert(document.cookie)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
];

describe("OPE-1368 — website fields refuse non-http(s) schemes", () => {
  const surfaces = [
    [
      "vendorProfileUpdateSchema.website",
      (v: string) => vendorProfileUpdateSchema.safeParse({ website: v }),
    ],
    ["vendorUpdateSchema.website", (v: string) => vendorUpdateSchema.safeParse({ website: v })],
    ["promoterUpdateSchema.website", (v: string) => promoterUpdateSchema.safeParse({ website: v })],
    ["venueUpdateSchema.website", (v: string) => venueUpdateSchema.safeParse({ website: v })],
    ["eventUpdateSchema.ticketUrl", (v: string) => eventUpdateSchema.safeParse({ ticketUrl: v })],
  ] as const;

  for (const [label, parse] of surfaces) {
    for (const bad of DANGEROUS) {
      it(`${label} rejects ${bad.slice(0, 24)}`, () => {
        expect(parse(bad).success).toBe(false);
      });
    }
    it(`${label} still accepts https and http`, () => {
      expect(parse("https://example.com/shop").success).toBe(true);
      expect(parse("http://example.com").success).toBe(true);
    });
  }

  it("still accepts empty string and null (clearing a field)", () => {
    expect(vendorProfileUpdateSchema.safeParse({ website: "" }).success).toBe(true);
    expect(vendorProfileUpdateSchema.safeParse({ website: null }).success).toBe(true);
  });

  it("upgrades a bare domain to https:// instead of refusing it (41 prod rows)", () => {
    const r = vendorProfileUpdateSchema.safeParse({ website: "www.ecomaine.org" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.website).toBe("https://www.ecomaine.org");
    const r2 = vendorUpdateSchema.safeParse({ website: "etsy.com/shop/ohitssoap.dukie" });
    expect(r2.success && r2.data.website).toBe("https://etsy.com/shop/ohitssoap.dukie");
  });

  it("leaves an existing https value byte-for-byte unchanged", () => {
    const r = vendorProfileUpdateSchema.safeParse({ website: "https://Example.com/a?b=1" });
    expect(r.success && r.data.website).toBe("https://Example.com/a?b=1");
  });
});

describe("OPE-1368 — applicationUrl allows mailto: but not javascript:/data:", () => {
  for (const [label, schema] of [
    ["eventUpdateSchema", eventUpdateSchema],
    ["promoterEventCreateSchema", promoterEventCreateSchema],
  ] as const) {
    it(`${label}: mailto accepted (2 prod rows are mailto:)`, () => {
      const r = schema.safeParse({ applicationUrl: "mailto:secretary@fair.org" });
      // promoterEventCreateSchema requires other fields; assert on the field's own issue only.
      const fieldIssue = !r.success && r.error.issues.some((i) => i.path[0] === "applicationUrl");
      expect(fieldIssue).toBe(false);
    });
    for (const bad of DANGEROUS) {
      it(`${label}: rejects ${bad.slice(0, 24)}`, () => {
        const r = schema.safeParse({ applicationUrl: bad });
        expect(r.success).toBe(false);
        expect(!r.success && r.error.issues.some((i) => i.path[0] === "applicationUrl")).toBe(true);
      });
    }
  }
});

describe("OPE-1368 — gallery image urls are http(s) only", () => {
  it("rejects a javascript: gallery url", () => {
    const r = vendorUpdateSchema.safeParse({
      gallery_images: [{ url: "javascript:alert(1)//", alt: "x" }],
    });
    expect(r.success).toBe(false);
  });
  it("accepts an https gallery url", () => {
    const r = vendorUpdateSchema.safeParse({
      gallery_images: [{ url: "https://cdn.example.com/a.jpg", alt: "x" }],
    });
    expect(r.success).toBe(true);
  });
});

describe("OPE-1368 — userProfileUpdateSchema caps name at 100", () => {
  it("accepts 100 chars, rejects 101", () => {
    expect(userProfileUpdateSchema.safeParse({ name: "a".repeat(100) }).success).toBe(true);
    expect(userProfileUpdateSchema.safeParse({ name: "a".repeat(101) }).success).toBe(false);
  });
});
