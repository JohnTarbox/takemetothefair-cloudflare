/**
 * OPE-102 — persist a single URL-inspection result into the state tables, so an
 * operator/analyst read via `get_url_inspection` / `get_bing_url_info` can double
 * as a state-table refresh (via `persist=true`).
 *
 * The per-URL inspection tools are otherwise pure-read: they hit Google/Bing,
 * cache briefly, and return the payload without touching `gsc_inspection_state` /
 * `bing_inspection_state` (only the sweep/cron writes those). That forced a
 * read-then-hand-UPSERT workaround on the OPE-94 blog backfill. These helpers make
 * the write a first-class opt-in that mirrors EXACTLY the column mapping the sweeps
 * use (`gsc-sweep.ts` runSweep / `bing-inspection-sweep.ts` runBingSweep — those
 * remain the canonical writers for the cron path; keep the two in sync).
 *
 * A distinctive `source` label on the GSC row marks tool-driven writes apart from
 * sweep-driven ones in the audit trail. `bing_inspection_state` has no source
 * column, so Bing writes are indistinguishable by design (documented in OPE-102).
 */
import type { Database } from "@/lib/db";
import { gscInspectionState, bingInspectionState } from "@/lib/db/schema";

/** Source label for a GSC state row written by an MCP inspection tool call. */
export const MCP_TOOL_SOURCE = "mcp-tool";

/**
 * Upsert one `gsc_inspection_state` row from a URL-Inspection result. `url` is the
 * full canonical URL (the table's PK, e.g. `https://meetmeatthefair.com/blog/x`).
 * Mirrors gsc-sweep.ts's upsert; `source` defaults to the MCP-tool label.
 */
export async function persistGscInspectionState(
  db: Database,
  opts: {
    url: string;
    verdict: string | null | undefined;
    coverage: string | null | undefined;
    now?: Date;
    source?: string;
  }
): Promise<void> {
  const now = opts.now ?? new Date();
  const verdict = opts.verdict ?? "UNKNOWN";
  const coverage = opts.coverage ?? null;
  const source = opts.source ?? MCP_TOOL_SOURCE;
  await db
    .insert(gscInspectionState)
    .values({
      url: opts.url,
      lastInspectedAt: now,
      lastVerdict: verdict,
      lastCoverageState: coverage,
      source,
    })
    .onConflictDoUpdate({
      target: gscInspectionState.url,
      // Re-label source on update so a persist call marks the row's provenance.
      set: { lastInspectedAt: now, lastVerdict: verdict, lastCoverageState: coverage, source },
    });
}

/**
 * Upsert one `bing_inspection_state` row from a `get_bing_url_info` result. `url`
 * is the full absolute URL (the table's PK). `lastCrawled` is the ISO string the
 * Bing tool returns (or null); it is converted to a Date for the timestamp column.
 * Mirrors bing-inspection-sweep.ts's upsert. No source column on this table.
 */
export async function persistBingInspectionState(
  db: Database,
  opts: {
    url: string;
    isIndexed: boolean | null;
    lastCrawled: string | null;
    crawlError: string | null;
    now?: Date;
  }
): Promise<void> {
  const now = opts.now ?? new Date();
  const lastCrawled = opts.lastCrawled ? new Date(opts.lastCrawled) : null;
  await db
    .insert(bingInspectionState)
    .values({
      url: opts.url,
      isIndexed: opts.isIndexed,
      lastCrawled,
      crawlError: opts.crawlError,
      lastCheckedAt: now,
    })
    .onConflictDoUpdate({
      target: bingInspectionState.url,
      set: {
        isIndexed: opts.isIndexed,
        lastCrawled,
        crawlError: opts.crawlError,
        lastCheckedAt: now,
      },
    });
}
