/**
 * OPE-69 — per-source `event_data_citations` provenance for the multi-source
 * inbound-email pipeline (OPE-55 Phase 3).
 *
 * `runMultiSourcePipeline` fans out over every contributing source (email body,
 * a linked URL, an OCR'd poster/PDF attachment) and creates / dedups events.
 * Before this, those events carried ZERO citation rows, so we lost the answer to
 * "which source told us this date?". This helper records one `event_data_citations`
 * row per tracked field per source, so provenance survives — and so "N sources
 * agreed on field X" is derivable later (multiple active rows are allowed by
 * design; see the supersede=false note below).
 *
 * Design invariants:
 *   - source_type is always "user_submitted" (the sender submitted the source
 *     via email, whatever its origin).
 *   - source_url is NOT NULL, so body / attachment sources synthesize a stable
 *     `email://…` identity (the body/attachment of the email IS the source).
 *   - We do NOT supersede prior citations. Multiple sources citing the same
 *     field must COEXIST as `active` rows — that coexistence is exactly how
 *     "N sources agreed" is computed. The schema has only an INDEX (not a
 *     unique constraint) on (event, field), so this is allowed.
 *   - Idempotent: a row is skipped when one already exists for the same
 *     (eventId, fieldName, sourceUrl) in state="active". This makes the helper
 *     safe under Workflow step retries and email redelivery.
 */
import { and, eq } from "drizzle-orm";
import { eventDataCitations } from "../schema.js";
import type { Db } from "../db.js";

/**
 * The origin of a citation. A structural subset of the workflow's
 * `SubmitSource` union (which additionally carries `text` / `imageKey`), so a
 * `SubmitSource` value is assignable here directly.
 */
export type CitationSource =
  | { kind: "body" }
  | { kind: "url"; url: string }
  | { kind: "attachment"; name: string };

/** The slice of `SubmitExtractResult` this helper reads. */
interface ExtractedForCitations {
  /** Source URL for url-sources; "" for body / attachment sources. */
  url: string;
  event: {
    name?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  };
  /** Per-field confidence from the extractor, keyed by the camelCase field
   *  name ("name", "startDate", "endDate", …). Sparsely populated. */
  fieldConfidence?: Record<string, "high" | "medium" | "low">;
}

/**
 * Tracked ExtractedEvent fields → citation `field_name` (snake_case, matching
 * the DENORM_FIELD_MAP allow-list in admin-citations.ts) + the fieldConfidence
 * key. ExtractedEvent only carries these three of the tracked fields — it has
 * no attendance / fee / ticket / deadline data at this layer, and venue_id is
 * intentionally skipped (the pipeline has a venue NAME, not an id).
 */
const CITATION_FIELDS: ReadonlyArray<{
  fieldName: string;
  confKey: string;
  get: (e: ExtractedForCitations["event"]) => string | null | undefined;
}> = [
  { fieldName: "name", confKey: "name", get: (e) => e.name },
  { fieldName: "start_date", confKey: "startDate", get: (e) => e.startDate },
  { fieldName: "end_date", confKey: "endDate", get: (e) => e.endDate },
];

/** Map extractor confidence buckets to a numeric score, or null when absent. */
function confidenceToScore(c: "high" | "medium" | "low" | undefined): number | null {
  switch (c) {
    case "high":
      return 0.9;
    case "medium":
      return 0.6;
    case "low":
      return 0.3;
    default:
      return null;
  }
}

/**
 * Derive the citation source identity (source_url + source_name) from the
 * source kind. source_url is NOT NULL in the schema, so body / attachment
 * sources synthesize an `email://` URL keyed on the sender.
 */
function sourceIdentity(
  source: CitationSource,
  fromAddress: string,
  extracted: ExtractedForCitations
): { sourceUrl: string; sourceName: string | null } {
  switch (source.kind) {
    case "url": {
      const url = extracted.url || source.url;
      let hostname: string | null = null;
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = null;
      }
      return { sourceUrl: url, sourceName: hostname };
    }
    case "body":
      return { sourceUrl: `email://${fromAddress}`, sourceName: "Email body" };
    case "attachment":
      return {
        sourceUrl: `email://${fromAddress}/attachment/${encodeURIComponent(source.name)}`,
        sourceName: `Attachment: ${source.name}`,
      };
  }
}

/**
 * Record one `event_data_citations` row per tracked, non-empty field on
 * `extracted.event`, attributed to `source`. Returns the number of rows
 * inserted (0 when nothing was citeable or every row was already present).
 *
 * Never supersedes; idempotent per (eventId, fieldName, sourceUrl) among
 * active rows.
 */
export async function recordSourceCitations(
  db: Db,
  args: {
    eventId: string;
    extracted: ExtractedForCitations;
    source: CitationSource;
    fromAddress: string;
  }
): Promise<number> {
  const { eventId, extracted, source, fromAddress } = args;
  const { sourceUrl, sourceName } = sourceIdentity(source, fromAddress, extracted);
  // A url-source with no URL has no provenance to attach — bail rather than
  // insert a NOT-NULL-violating empty source_url.
  if (!sourceUrl) return 0;

  // Idempotency guard: which fields already have an active citation from THIS
  // exact source? Skip those so retries / redelivery don't duplicate. Scoped
  // to sourceUrl, so a DIFFERENT source citing the same field still inserts
  // (that coexistence is the "N sources agreed" signal).
  const existing = await db
    .select({ fieldName: eventDataCitations.fieldName })
    .from(eventDataCitations)
    .where(
      and(
        eq(eventDataCitations.eventId, eventId),
        eq(eventDataCitations.sourceUrl, sourceUrl),
        eq(eventDataCitations.state, "active")
      )
    );
  const alreadyCited = new Set(existing.map((r) => r.fieldName));

  const rows: (typeof eventDataCitations.$inferInsert)[] = [];
  for (const f of CITATION_FIELDS) {
    const raw = f.get(extracted.event);
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    if (value.trim().length === 0) continue;
    if (alreadyCited.has(f.fieldName)) continue;
    rows.push({
      eventId,
      fieldName: f.fieldName,
      value,
      year: null,
      sourceUrl,
      sourceName,
      sourceType: "user_submitted",
      confidence: confidenceToScore(extracted.fieldConfidence?.[f.confKey]),
      state: "active",
      createdBy: null,
    });
  }

  if (rows.length === 0) return 0;
  await db.insert(eventDataCitations).values(rows);
  return rows.length;
}
