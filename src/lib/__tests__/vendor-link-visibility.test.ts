/**
 * OPE-316 — the public boundary for event↔vendor links.
 *
 * "Hidden" has to mean hidden EVERYWHERE public, including schema.org. A single
 * missed surface turns a privacy commitment into a leak, and the leak is silent
 * — nobody notices a vendor is visible who asked not to be.
 *
 * So this pins the split rather than the SQL: public surfaces must use the
 * visibility-aware predicate; admin/analytics keep the status-only one, because
 * the whole point is that a hidden link still COUNTS where the operator looks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Surfaces whose output reaches an anonymous visitor. */
const PUBLIC_SURFACES = [
  "src/app/events/[slug]/event-detail-data.ts",
  "src/app/events/page.tsx",
  "src/app/events/past/page.tsx",
  "src/app/vendors/page.tsx",
  "src/app/vendors/[slug]/page.tsx",
  "src/app/api/events/[slug]/vendors/route.ts",
  "src/components/events/state-events-page.tsx",
  "src/components/events/category-events-page.tsx",
  "src/lib/vendors/vendor-events.ts",
];

/** Operator-only surfaces, which MUST still see hidden links. */
const ADMIN_SURFACES = ["src/app/admin/page.tsx"];

describe("OPE-316 — hidden participation never renders publicly", () => {
  it.each(PUBLIC_SURFACES)("%s filters on link visibility", (file) => {
    const src = read(file);
    expect(src).toContain("isPubliclyVisibleVendorLink");
    // The status-only predicate must not survive on a public surface — that's
    // exactly the shape of the leak: right-looking filter, wrong question.
    expect(src).not.toMatch(/\bisPublicVendorStatus\s*\(/);
  });

  it.each(ADMIN_SURFACES)("%s still counts hidden links", (file) => {
    const src = read(file);
    expect(src).toMatch(/\bisPublicVendorStatus\s*\(/);
    expect(src).not.toContain("isPubliclyVisibleVendorLink");
  });

  it("the public predicate requires BOTH status and visibility", () => {
    // If it ever collapses to one condition, hidden links leak (dropped
    // visibility) or rejected ones surface (dropped status).
    const src = read("src/lib/vendor-status.ts");
    const fn = src.slice(src.indexOf("export function isPubliclyVisibleVendorLink"));
    expect(fn).toContain("isPublicVendorStatus()");
    expect(fn).toContain("publicVisible");
  });
});
