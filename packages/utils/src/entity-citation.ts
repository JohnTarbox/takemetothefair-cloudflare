/**
 * OPE-433 scope 4 — the shape of a provenance claim about a venue or an
 * event_day, and the rules for deciding whether one is worth writing.
 *
 * Pure. It builds and filters rows; the two codebases own their own inserts,
 * the same split as every other shared rule here (app and MCP are separate
 * builds, so a single runtime writer is not available).
 *
 * ── What this is actually for ────────────────────────────────────────────
 *
 * `events` has field-level evidence via `event_data_citations`. `venues` and
 * `event_days` have none — no source, no ingestion method, no verified-at. And
 * that is exactly where the defects cluster: both logged fabricated-fact
 * instances live in `event_days` (MDI's invented 10-5/10-4/10-3 hours against a
 * published flat 9-4, and OPE-411's 09:00–18:00 rows), 256 of 2,008 day rows
 * carry no hours, 167 of 963 active venues carry no address.
 *
 * The causal claim in the ticket is worth restating because it drives the
 * design: what is not attributed does not get audited, and what is not audited
 * drifts.
 */

/** Entities that get provenance here. Events are excluded on purpose — they
 *  have `event_data_citations`, and accepting them would create two answers to
 *  one question. */
export type CitableEntityType = "VENUE" | "EVENT_DAY";

export type CitationSourceType =
  | "official_website"
  | "news_article"
  | "press_release"
  | "social_media"
  | "user_submitted"
  | "other";

export interface EntityCitationInput {
  entityType: CitableEntityType;
  entityId: string;
  fieldName: string;
  value: unknown;
  sourceUrl: string;
  sourceName?: string | null;
  sourceType: CitationSourceType;
  confidence?: number | null;
  notes?: string | null;
  createdBy?: string | null;
}

export interface EntityCitationRow {
  entityType: CitableEntityType;
  entityId: string;
  fieldName: string;
  value: string;
  sourceUrl: string;
  sourceName: string | null;
  sourceType: CitationSourceType;
  confidence: number | null;
  state: "active";
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * Fields worth attributing, per entity.
 *
 * An allow-list rather than "every column", for the same reason
 * `DENORM_FIELD_MAP` is one on the event side: a citation on `updated_at` or on
 * an internal counter is noise that makes the real ones harder to find.
 *
 * These are the fields a source can actually be wrong about in a way a reader
 * would notice — which is the same list as the observed defects.
 */
export const CITABLE_FIELDS: Record<CitableEntityType, ReadonlySet<string>> = {
  VENUE: new Set(["name", "address", "city", "state", "zip", "latitude", "longitude", "website"]),
  EVENT_DAY: new Set(["date", "open_time", "close_time", "notes"]),
};

/**
 * Is this value worth a citation row?
 *
 * Empty is not a claim. Attributing "we believe the close time is nothing" to a
 * source states something the source never said, and would let a row satisfy a
 * has-provenance check while carrying no evidence — which is precisely the
 * "require a citation degrades to require a row" failure the OPE-433 thread
 * warned about.
 */
export function isCiteableValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

/**
 * Build the rows for one source's claims about one entity.
 *
 * Silently drops fields outside the allow-list and values that assert nothing,
 * so a caller can hand over a whole patch object without pre-filtering. Returns
 * an empty array when there is nothing to attribute — which is a normal
 * outcome, not an error: plenty of writes (a geocode sweep filling coordinates
 * from Google) have a real source, and plenty (an operator fixing a typo) have
 * none, and the second kind should record nothing here rather than a fiction.
 */
export function buildEntityCitations(
  entityType: CitableEntityType,
  entityId: string,
  fields: Record<string, unknown>,
  source: {
    sourceUrl: string;
    sourceName?: string | null;
    sourceType: CitationSourceType;
    confidence?: number | null;
    notes?: string | null;
    createdBy?: string | null;
  },
  now: Date
): EntityCitationRow[] {
  if (!entityId || !source.sourceUrl) return [];
  const allowed = CITABLE_FIELDS[entityType];
  const rows: EntityCitationRow[] = [];
  for (const [fieldName, value] of Object.entries(fields)) {
    if (!allowed.has(fieldName)) continue;
    if (!isCiteableValue(value)) continue;
    rows.push({
      entityType,
      entityId,
      fieldName,
      value: String(value),
      sourceUrl: source.sourceUrl,
      sourceName: source.sourceName ?? null,
      sourceType: source.sourceType,
      confidence: source.confidence ?? null,
      state: "active",
      notes: source.notes ?? null,
      createdBy: source.createdBy ?? null,
      createdAt: now,
    });
  }
  return rows;
}

/**
 * Map a camelCase patch (what the write paths actually hold) onto the
 * snake_case field names the citation table uses.
 *
 * Kept here rather than at each call site so the two codebases cannot drift
 * into citing `openTime` in one place and `open_time` in the other — a
 * divergence that would split one field's evidence into two buckets and make
 * both look thinner than they are.
 */
export const CAMEL_TO_CITATION_FIELD: Record<string, string> = {
  name: "name",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  latitude: "latitude",
  longitude: "longitude",
  website: "website",
  date: "date",
  openTime: "open_time",
  closeTime: "close_time",
  notes: "notes",
  // The canonical forms map to themselves. Without these, a caller that
  // already holds snake_case keys — anything reading a D1 row rather than a
  // Drizzle model — has its fields silently DROPPED, and a citation that
  // should exist simply never appears. Caught by a test asserting pass-through
  // that I had assumed was already true.
  open_time: "open_time",
  close_time: "close_time",
};

/** Rename a camelCase patch's keys to citation field names, dropping anything
 *  unmapped. */
export function toCitationFields(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const mapped = CAMEL_TO_CITATION_FIELD[k];
    if (mapped) out[mapped] = v;
  }
  return out;
}
