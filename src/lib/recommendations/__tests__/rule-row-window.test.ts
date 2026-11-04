import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRulePage,
  RULE_PAGE_SIZE,
  RULE_PREVIEW_LIMIT,
  ruleRowWindow,
} from "../rule-row-window";

describe("ruleRowWindow (OPE-1574)", () => {
  it("previews the first RULE_PREVIEW_LIMIT rows of an unfocused rule", () => {
    const w = ruleRowWindow({ total: 7269, focused: false });
    expect(w).toEqual({
      start: 0,
      end: RULE_PREVIEW_LIMIT,
      page: 1,
      pageCount: 1,
      truncated: true,
    });
  });

  it("shows a small unfocused rule whole and not truncated", () => {
    expect(ruleRowWindow({ total: 3, focused: false })).toMatchObject({
      start: 0,
      end: 3,
      truncated: false,
    });
    expect(ruleRowWindow({ total: 0, focused: false })).toMatchObject({ end: 0, truncated: false });
  });

  it("pages a focused rule in RULE_PAGE_SIZE chunks", () => {
    const total = RULE_PAGE_SIZE * 2 + 17;
    expect(ruleRowWindow({ total, focused: true, page: 1 })).toEqual({
      start: 0,
      end: RULE_PAGE_SIZE,
      page: 1,
      pageCount: 3,
      truncated: true,
    });
    expect(ruleRowWindow({ total, focused: true, page: 3 })).toEqual({
      start: RULE_PAGE_SIZE * 2,
      end: total,
      page: 3,
      pageCount: 3,
      truncated: true,
    });
  });

  it("clamps an out-of-range page instead of rendering nothing", () => {
    const w = ruleRowWindow({ total: 450, focused: true, page: 99 });
    expect(w.page).toBe(3);
    expect(w.end - w.start).toBeGreaterThan(0);
    expect(ruleRowWindow({ total: 450, focused: true, page: -4 }).page).toBe(1);
  });

  it("every row of a focused rule is reachable through its pages, exactly once", () => {
    const total = 7269;
    const { pageCount } = ruleRowWindow({ total, focused: true, page: 1 });
    let covered = 0;
    let expectedStart = 0;
    for (let p = 1; p <= pageCount; p++) {
      const w = ruleRowWindow({ total, focused: true, page: p });
      expect(w.start).toBe(expectedStart);
      covered += w.end - w.start;
      expectedStart = w.end;
    }
    expect(covered).toBe(total);
  });

  it("never windows more than RULE_PAGE_SIZE rows for any rule", () => {
    for (const total of [0, 1, 24, 25, 26, 199, 200, 201, 25_354]) {
      for (const focused of [false, true]) {
        const w = ruleRowWindow({ total, focused, page: 1 });
        expect(w.end - w.start).toBeLessThanOrEqual(RULE_PAGE_SIZE);
      }
    }
  });

  it("parseRulePage falls back to 1 on junk", () => {
    expect(parseRulePage(undefined)).toBe(1);
    expect(parseRulePage("")).toBe(1);
    expect(parseRulePage("abc")).toBe(1);
    expect(parseRulePage("0")).toBe(1);
    expect(parseRulePage("-2")).toBe(1);
    expect(parseRulePage("4")).toBe(4);
  });
});

/**
 * Structural guard: the Recommendations tab must slice each rule's sorted
 * items by the window before mapping them to rows. Without the slice the tab
 * renders every active item again (39 MB of HTML on prod, 2026-11-04).
 */
describe("Recommendations tab renders a window, not every item (OPE-1574)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");
  const tabStart = src.indexOf("async function RecommendationsTab(");
  const tabEnd = src.indexOf("\n}\n", tabStart);
  const tab = src.slice(tabStart, tabEnd);

  it("locates the RecommendationsTab body (landmark)", () => {
    expect(tabStart).toBeGreaterThan(-1);
    expect(tab).toContain("<RecommendationActions itemId={item.itemId} />");
  });

  it("every `[...group.items]` row list is sliced by the window before .map", () => {
    const lists = [...tab.matchAll(/\[\.\.\.group\.items\]([\s\S]*?)\.map\(\(item\)/g)];
    // Landmark: the per-rule row list exists, so a zero here is a broken matcher.
    expect(lists.length).toBeGreaterThanOrEqual(1);
    for (const m of lists) {
      expect(m[1]).toContain(".slice(win.start, win.end)");
    }
  });

  it("does not map group.items directly to rows anywhere in the tab", () => {
    expect(tab).not.toMatch(/group\.items\s*\.map\(/);
  });
});
