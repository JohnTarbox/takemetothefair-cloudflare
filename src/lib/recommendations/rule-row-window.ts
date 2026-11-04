/**
 * OPE-1574 — which slice of a rule's items the Recommendations tab renders.
 *
 * The tab used to render EVERY active item (~25.6K rows on prod, 2026-11-04)
 * inside collapsed <details>; collapsed is still serialized, so the page was
 * 39 MB of HTML. Counts are still computed from the full item set — only the
 * rendered rows are windowed here.
 *
 * - Unfocused rule: the first RULE_PREVIEW_LIMIT rows, plus a "view all" link.
 * - Focused rule (`?rule=<ruleId>`): pages of RULE_PAGE_SIZE, 1-based `page`.
 */
export const RULE_PREVIEW_LIMIT = 25;
export const RULE_PAGE_SIZE = 200;

export interface RuleRowWindow {
  /** Inclusive start index into the sorted item list. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /** 1-based page actually shown (clamped). Always 1 when unfocused. */
  page: number;
  /** Total pages for a focused rule; 1 when unfocused. */
  pageCount: number;
  /** True when rows exist outside [start, end). */
  truncated: boolean;
}

export function ruleRowWindow(opts: {
  total: number;
  focused: boolean;
  page?: number;
}): RuleRowWindow {
  const total = Math.max(0, Math.floor(opts.total));
  if (!opts.focused) {
    const end = Math.min(total, RULE_PREVIEW_LIMIT);
    return { start: 0, end, page: 1, pageCount: 1, truncated: end < total };
  }
  const pageCount = Math.max(1, Math.ceil(total / RULE_PAGE_SIZE));
  const requested =
    typeof opts.page === "number" && Number.isFinite(opts.page) ? Math.floor(opts.page) : 1;
  const page = Math.min(pageCount, Math.max(1, requested));
  const start = (page - 1) * RULE_PAGE_SIZE;
  const end = Math.min(total, start + RULE_PAGE_SIZE);
  return { start, end, page, pageCount, truncated: start > 0 || end < total };
}

/** Parse a `?rpage=` value; anything non-numeric falls back to page 1. */
export function parseRulePage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
