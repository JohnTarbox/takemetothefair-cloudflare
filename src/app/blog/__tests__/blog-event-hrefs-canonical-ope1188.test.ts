/**
 * OPE-1188 follow-up — every event link the blog post page renders goes
 * through the canonical-href resolver. The body was fixed first; the sidebar
 * cards still interpolated `/events/<slug>`, and a series occurrence cost a
 * 301 hop there (measured 2026-10-01 on the Fryeburg guide: "Fryeburg Fair
 * 2026" → /events/fryeburg-fair-2026 → 301). Keyed on the ACT — any raw
 * interpolation of an event href — not on the two places fixed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../[slug]/page.tsx"), "utf8");

describe("blog post page — event hrefs", () => {
  it("never interpolates /events/<slug> into an href", () => {
    const raw = SRC.match(/href=\{`\/events\/\$\{/g) ?? [];
    expect(raw).toEqual([]);
  });
  it("routes the sidebar cards through eventHref (a zero here would make the guard above inert)", () => {
    expect((SRC.match(/href=\{eventHref\(/g) ?? []).length).toBe(2);
  });
});
