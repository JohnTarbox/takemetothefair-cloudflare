/**
 * OPE-495 — record a slug rename so the old URL keeps redirecting.
 *
 * ## The defect this exists to close
 *
 * Six entities carry a `*_slug_history` table, and `src/middleware.ts` walks
 * each of them to 301 a renamed URL to its current one. But the MCP write paths
 * were only half-wired: `update_event`, `update_vendor` and `update_performer`
 * wrote their history row, while `update_promoter` and `update_venue` — which
 * regenerate the slug from `name` through the identical collision loop — wrote
 * nothing. A rename through those tools changed the public URL and left the old
 * one 404ing, with no trace that a redirect was ever owed.
 *
 * Measured in prod on 2026-08-20: `promoter_slug_history` held 10 rows and
 * `venue_slug_history` 10, EVERY one of them written by `admin-user-001` via the
 * admin UI. Not a single MCP-originated rename had ever landed in either table,
 * across the whole life of both.
 *
 * ## Why it stayed invisible
 *
 * Renaming an event-named promoter to its real organisation ("Cape Cod Creative
 * Arts Festival" -> "Creative Arts Center") is a ROUTINE correction — 10 of the
 * 10 admin rows are exactly that shape. The tool reports the slug change in its
 * own response and returns success. Nothing anywhere says a redirect was owed
 * and not written, so the cost only shows up later as a 404 on a URL a search
 * engine still holds.
 *
 * ## Fail-soft, deliberately
 *
 * The rename itself has already been committed by the time this runs. Throwing
 * here would fail a tool call whose primary write SUCCEEDED, turning a missing
 * redirect into a confusing partial error — so a failure is logged loudly and
 * swallowed. This mirrors the placement and the comment `update_event` has
 * carried since drizzle/0061.
 */
import type { Slug } from "@takemetothefair/utils";
import { unsafeSlug } from "./helpers.js";

export interface SlugRenameInput {
  /** Tool name for the log line, e.g. "update_promoter". */
  label: string;
  /** Entity id, for the log line. */
  entityId: string;
  previousSlug: string | null | undefined;
  nextSlug: string | null | undefined;
  /** Performs the INSERT. Called only when the slug genuinely changed. */
  write: (oldSlug: Slug, newSlug: Slug) => Promise<unknown>;
}

/**
 * True when this is a real rename worth a redirect row.
 *
 * Guards the two shapes that would otherwise write junk history: a no-op edit
 * that re-derives the SAME slug (very common — `update_promoter` regenerates the
 * slug whenever `name` is passed, even when the name is unchanged), and a
 * missing value on either side.
 */
export function isRealSlugRename(
  previousSlug: string | null | undefined,
  nextSlug: string | null | undefined
): boolean {
  if (typeof previousSlug !== "string" || previousSlug.length === 0) return false;
  if (typeof nextSlug !== "string" || nextSlug.length === 0) return false;
  return previousSlug !== nextSlug;
}

/**
 * Write the history row for a rename. Returns true when a row was written.
 *
 * Never throws: see the fail-soft note above.
 */
export async function recordSlugRename(input: SlugRenameInput): Promise<boolean> {
  const { label, entityId, previousSlug, nextSlug, write } = input;
  if (!isRealSlugRename(previousSlug, nextSlug)) return false;
  try {
    await write(unsafeSlug(previousSlug as string), unsafeSlug(nextSlug as string));
    return true;
  } catch (err) {
    console.error(
      `[MCP/${label}] failed to write slug history for ${entityId} (${previousSlug} → ${nextSlug}):`,
      err
    );
    return false;
  }
}
