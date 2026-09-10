/**
 * OPE-884 — decide which of an event's `tags` a visitor may see.
 *
 * `events.tags` is one column carrying two populations: descriptors a visitor
 * wants ("italian", "free-admission") and pipeline bookkeeping the queue writes
 * to itself ("src:daily-discovery", "needs-enrichment:image"). The event page
 * renders that column as a hashtag row, so anything the filter misses is
 * published to the public as though it described the festival.
 *
 * ## Why this replaced an inline denylist
 *
 * The previous filter lived inline in the event-detail page and worked by
 * ENUMERATING names — `needs-review`, `needs-image`, `needs-dates`, plus prefix
 * tests for exactly two namespaces (`admin:`, `internal:`). It was correct for
 * every tag it had been told about, and blind to every tag minted afterwards.
 * By 2026-09-10 the discovery pass and the enrichment queue were writing
 * `src:daily-discovery`, `needs-enrichment`, `needs-enrichment:image`,
 * `needs-venue` and `needs-hero-image` — none of them on the list — and the leak
 * reached 64 of 573 upcoming APPROVED events, including a page with 246 views.
 *
 * A denylist of names cannot hold this line: the emitters are free to invent
 * names and nothing makes them tell the renderer. So the rules below are
 * STRUCTURAL — they key on the SHAPE of an internal tag, not its spelling:
 *
 *   1. `:` anywhere      → namespaced, i.e. machine-written (`src:*`, `admin:*`,
 *                          `needs-enrichment:image`, and any future namespace)
 *   2. `.` anywhere      → versioned/qualified (`fmt.v2`) — pre-existing rule
 *   3. leading `needs-`  → workflow state, by construction. A visitor is never
 *                          served "what this record is still missing".
 *
 * The exact-name set below is what survives from the old list: legacy tags that
 * are internal but carry NO structural marker, so nothing but their name
 * identifies them. It should not grow — a new internal tag should be namespaced
 * (`src:`, `admin:`, `needs-`) and be caught by shape instead.
 *
 * Verified against production before shipping: every distinct tag on an APPROVED
 * non-merged event matching rule 1 or 3 is internal (9 tokens — `src:*` ×4,
 * `needs-*` ×5), and no visitor-facing descriptor uses either shape.
 */

/**
 * Legacy internal tags with no structural marker. Matched case-insensitively
 * after trimming. Do NOT add to this — namespace new internal tags instead.
 */
export const LEGACY_INTERNAL_TAGS: ReadonlySet<string> = new Set([
  // Ingest-source (pre-dates the `src:` namespace)
  "imported",
  "url-import",
  "community-suggestion",
  "vendor-submission",
  // Scheduling-shape (UX-A1, 2026-06-04)
  "weekends-only",
  "weekdays-only",
  "recurring",
  "ongoing",
  // Workflow/admin (UX-A1) that predate the `needs-` family rule
  "dedup-suspect",
  "draft",
  "internal",
]);

/**
 * True when a tag is pipeline bookkeeping rather than something a visitor
 * should read. Structural rules first, then the legacy name set.
 */
export function isInternalTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  if (normalized === "") return true;
  // 1 — namespaced (src:, admin:, internal:, needs-enrichment:image, …)
  if (normalized.includes(":")) return true;
  // 2 — versioned/qualified (fmt.v2)
  if (normalized.includes(".")) return true;
  // 3 — the needs-* workflow family, present and future
  if (normalized.startsWith("needs-")) return true;
  return LEGACY_INTERNAL_TAGS.has(normalized);
}

/**
 * The subset of `tags` that may be rendered publicly. Order and original casing
 * are preserved — this only removes.
 */
export function filterPublicTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !isInternalTag(tag));
}
