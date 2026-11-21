/**
 * OPE-1286 — the newsletter lane names the promoter whose newsletter it read.
 * The route honours that `promoterId` only from an internal caller, and only
 * when the row exists; a public caller's value must never pick an owner.
 *
 * Source-level, like the other tests in this folder (the route is a Next
 * handler with D1, Turnstile and rate-limit dependencies; what is under test is
 * wiring), plus the schema, which is importable.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { submitEventSchema } from "../schema";

const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/suggest-event/submit/route.ts"),
  "utf8"
);

describe("OPE-1286 — a stated promoter is an internal-only input", () => {
  it("the schema carries promoterId (and still parses without it)", () => {
    const base = { name: "Christmas in the Valley Craft Fair", startDate: "2026-12-05" };
    expect(submitEventSchema.parse({ ...base, promoterId: "cff0a829" }).promoterId).toBe(
      "cff0a829"
    );
    expect(submitEventSchema.parse(base).promoterId).toBeUndefined();
  });

  it("landmark: the route reads data.promoterId exactly once, inside the isInternal guard", () => {
    expect(ROUTE.split("data.promoterId").length - 1).toBe(2); // the guard + the where
    expect(ROUTE).toMatch(/isInternal && data\.promoterId\s*\?\s*await db/);
  });

  it("the stated owner is looked up, and only a found row overrides URL inference", () => {
    const at = ROUTE.indexOf("const statedOwner =");
    expect(at).toBeGreaterThan(-1);
    const block = ROUTE.slice(at, at + 900);
    expect(block).toContain(".where(eq(promoters.id, data.promoterId))");
    expect(block).toMatch(/if \(statedOwner\) \{\s*resolvedPromoterId = statedOwner;\s*\} else \{/);
    // inference still runs on the else branch
    expect(block).toContain("resolvePromoterForSource(db, {");
  });
});
