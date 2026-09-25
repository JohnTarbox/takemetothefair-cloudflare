/**
 * OPE-1159 — every /admin/analytics card has a tooltip, and every tooltip has a card.
 *
 * TypeScript already stops a card from naming a definition that does not exist
 * (`TileId` is derived from the registry keys, and `KpiCard` / `SparklineCard` /
 * `ActivityFeedCard` require it). What a type cannot see is the other two
 * directions, which this pins:
 *
 *  1. **A card with no ⓘ at all.** Every `<Card>…</Card>` region in page.tsx must
 *     contain a `<TileInfo`, except the reviewed allowlist below.
 *  2. **A definition whose card was deleted.** The IDs the page references and
 *     the registry's keys must be the same set.
 *
 * Source-level, like the other analytics guards: the page is a server component
 * over D1, GSC, Bing and GA4, and what is under test is wiring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TILE_DEFINITIONS } from "../tile-definitions";

const PAGE = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");
const VERDICT = readFileSync(join(process.cwd(), "src/lib/site-health-unified/verdict.ts"), "utf8");

/**
 * Cards that are not measurements, by enclosing function, each with its reason.
 * Adding a name here is a reviewed decision, not a way to silence the guard.
 */
const NO_TOOLTIP_ALLOWED: Record<string, string> = {
  GscErrorPanel: "replaces the whole Google tab when GSC is misconfigured or down — not a card",
  BingErrorPanel: "replaces the whole Bing tab when Bing WMT is misconfigured or down — not a card",
};

function enclosingFunction(pos: number): string | null {
  let name: string | null = null;
  for (const m of PAGE.matchAll(/^(?:async )?function (\w+)/gm)) {
    if ((m.index ?? 0) > pos) break;
    name = m[1];
  }
  return name;
}

function cardRegions(): Array<{ fn: string | null; body: string; line: number }> {
  const out: Array<{ fn: string | null; body: string; line: number }> = [];
  for (const m of PAGE.matchAll(/<Card(?=[\s>])/g)) {
    const start = m.index ?? 0;
    const end = PAGE.indexOf("</Card>", start);
    const body = PAGE.slice(start, end);
    // A nested card would make "first </Card>" the wrong close — refuse to guess.
    expect(body.slice(1).search(/<Card(?=[\s>])/), `nested <Card> at offset ${start}`).toBe(-1);
    out.push({ fn: enclosingFunction(start), body, line: PAGE.slice(0, start).split("\n").length });
  }
  return out;
}

/** Every tile ID the page references: literal props, plus the instrument template. */
function idsUsedByPage(): Set<string> {
  const ids = new Set<string>();
  for (const m of PAGE.matchAll(/<TileInfo\s+id="([^"]+)"/g)) ids.add(m[1]);
  for (const m of PAGE.matchAll(/\btileId="([^"]+)"/g)) ids.add(m[1]);
  // InstrumentTile builds `site-health.instrument.${reading.key}`; the keys are
  // the InstrumentKey union, read from its declaration rather than restated.
  expect(PAGE).toContain("`site-health.instrument.${reading.key}`");
  const union = VERDICT.match(/export type InstrumentKey = ([^;]+);/);
  expect(union, "InstrumentKey declaration not found in verdict.ts").not.toBeNull();
  for (const m of union![1].matchAll(/"([^"]+)"/g)) ids.add(`site-health.instrument.${m[1]}`);
  return ids;
}

describe("OPE-1159 — every analytics card carries a tooltip", () => {
  it("landmark: the scan finds the page's cards (a matcher that stops matching must fail)", () => {
    expect(cardRegions().length).toBeGreaterThan(40);
  });

  it("every <Card> region renders a <TileInfo>, except the reviewed allowlist", () => {
    const missing = cardRegions()
      .filter((c) => !c.body.includes("<TileInfo"))
      .filter((c) => !(c.fn && c.fn in NO_TOOLTIP_ALLOWED))
      .map((c) => `page.tsx:${c.line} (${c.fn})`);
    expect(missing).toEqual([]);
  });

  it("the allowlist names only functions that still exist", () => {
    for (const fn of Object.keys(NO_TOOLTIP_ALLOWED)) {
      expect(PAGE, `allowlisted ${fn} no longer exists`).toMatch(
        new RegExp(`^function ${fn}\\(`, "m")
      );
    }
  });
});

describe("OPE-1159 — the registry and the page name the same tiles", () => {
  it("every ID the page uses has a definition, and every definition has a card", () => {
    const used = [...idsUsedByPage()].sort();
    const defined = Object.keys(TILE_DEFINITIONS).sort();
    expect(used.filter((id) => !defined.includes(id))).toEqual([]); // no definition
    expect(defined.filter((id) => !used.includes(id))).toEqual([]); // orphaned definition
    expect(defined.length).toBeGreaterThan(60); // landmark
  });

  it("no definition is empty — a blank tooltip is the failure this ticket exists to stop", () => {
    for (const [id, d] of Object.entries(TILE_DEFINITIONS)) {
      for (const field of ["measures", "source", "window"] as const) {
        expect(d[field]?.trim(), `${id}.${field}`).toBeTruthy();
      }
    }
  });
});
