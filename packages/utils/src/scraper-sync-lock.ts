/**
 * OPE-1393 (CLB5) — an operator edit to a field the scraper sync writes turns
 * the event's scraper sync OFF.
 *
 * `PATCH /api/admin/import` (bulk sync) and `POST /api/admin/import` with
 * `updateExisting` both overwrite these columns on every `sync_enabled=1` row
 * whenever the scrape differs, with no notion of who wrote the current value.
 * The admin edit form and MCP `update_event` never cleared `sync_enabled`, so a
 * hand correction stayed live only until the next sync. Clearing the flag at
 * the moment of the edit is the simplest guard (the ticket's chosen fix); the
 * operator can turn sync back on explicitly.
 *
 * Shared by the main app's admin PATCH and the MCP Worker's `update_event`, so
 * both write surfaces apply one rule.
 */

/** Columns the scraper sync / re-import paths write (camelCase Drizzle keys). */
export const SCRAPER_SYNCED_EVENT_FIELDS = [
  "name",
  "description",
  "startDate",
  "endDate",
  "imageUrl",
  "ticketUrl",
  "venueId",
] as const;

export type ScraperSyncedEventField = (typeof SCRAPER_SYNCED_EVENT_FIELDS)[number];

const DATE_FIELDS = new Set<ScraperSyncedEventField>(["startDate", "endDate"]);

function normalize(field: ScraperSyncedEventField, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (DATE_FIELDS.has(field)) {
    const d = v instanceof Date ? v : new Date(v as string | number);
    if (Number.isNaN(d.getTime())) return null;
    // Day granularity: event dates are calendar days. A form resave that
    // re-anchors a legacy midnight-UTC row to noon UTC is not an edit.
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * The synced fields whose value actually CHANGES between `current` (the row as
 * stored) and `next` (the pending update). A key absent from `next`, or set to
 * `undefined`, is not being written. A resave of an unchanged value — the admin
 * form posts every field on every save — is not an edit.
 */
export function changedScraperSyncedFields(
  current: Partial<Record<ScraperSyncedEventField, unknown>>,
  next: Record<string, unknown>
): ScraperSyncedEventField[] {
  const changed: ScraperSyncedEventField[] = [];
  for (const f of SCRAPER_SYNCED_EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(next, f) || next[f] === undefined) continue;
    if (normalize(f, next[f]) !== normalize(f, current[f])) changed.push(f);
  }
  return changed;
}

/**
 * Should this edit turn scraper sync off?
 *
 * - `currentSyncEnabled`: the row's stored flag. Already off → nothing to do.
 * - `explicitSyncEnabled`: a sync_enabled value the operator deliberately set
 *   in this same request, or `undefined` if they expressed no intent. An
 *   explicit value always wins (an operator may edit a field AND keep sync on).
 *   Callers whose form always posts the flag should pass `undefined` unless it
 *   differs from the stored value.
 */
export function shouldDisableScraperSync(args: {
  currentSyncEnabled: boolean | null | undefined;
  explicitSyncEnabled: boolean | undefined;
  changedFields: readonly ScraperSyncedEventField[];
}): boolean {
  if (args.currentSyncEnabled === false) return false;
  if (args.explicitSyncEnabled !== undefined) return false;
  return args.changedFields.length > 0;
}
