/**
 * OPE-1389 — an UPDATE schema invents nothing for a key the caller did not send.
 *
 * zod 4 keeps `.optional().default(x)` through `.partial()`, so these four
 * parsed `{}` into a body full of CREATE defaults (categories [], status DRAFT,
 * verified false, amenities [], …) and every admin PATCH wrote them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  eventCreateSchema,
  eventUpdateSchema,
  promoterCreateSchema,
  promoterUpdateSchema,
  vendorUpdateSchema,
  venueUpdateSchema,
  withoutDefaults,
} from "./index";

describe("OPE-1389 — update schemas parse {} to {}", () => {
  it.each([
    ["eventUpdateSchema", eventUpdateSchema],
    ["vendorUpdateSchema", vendorUpdateSchema],
    ["venueUpdateSchema", venueUpdateSchema],
    ["promoterUpdateSchema", promoterUpdateSchema],
  ] as const)("%s.parse({}) is {}", (_name, schema) => {
    expect(schema.parse({})).toEqual({});
  });

  it("an Enhanced-Profile-style body carries only what it sent", () => {
    expect(vendorUpdateSchema.parse({ claimed: true })).toEqual({ claimed: true });
  });

  it("sent values still pass through, including explicit empties", () => {
    expect(eventUpdateSchema.parse({ categories: [], featured: false })).toEqual({
      categories: [],
      featured: false,
    });
  });
});

describe("OPE-1389 — create schemas keep their defaults", () => {
  it("eventCreateSchema still fills status/categories/focal on create", () => {
    const r = eventCreateSchema.parse({ name: "Fair", promoterId: "p1", stateCode: "ME" });
    expect(r.status).toBe("DRAFT");
    expect(r.categories).toEqual([]);
    expect(r.imageFocalX).toBe(0.5);
  });

  it("promoterCreateSchema still defaults verified=false", () => {
    expect(promoterCreateSchema.parse({ companyName: "Acme" }).verified).toBe(false);
  });
});

describe("withoutDefaults", () => {
  it("strips a top-level default but keeps the field's validation", () => {
    const s = withoutDefaults(z.object({ n: z.number().min(1).optional().default(3) }));
    expect(s.parse({})).toEqual({});
    expect(s.safeParse({ n: 0 }).success).toBe(false);
  });
});
