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
 * OPE-457 scope 2 — `source_type` must describe HOW the value was obtained,
 * not which inbox it arrived through.
 *
 * Everything from this pipeline used to be `user_submitted`, which is true of
 * the *submission* and false of the *value*. It matters because OPE-433 grades
 * trust by lane: a value scraped off a third-party page is `direct_scrape` and
 * belongs in a less-trusted lane than something the sender typed. Labelling
 * scrape output as user submission promotes it into a lane the confidence rules
 * will treat as better evidence than it is.
 */
type CitationSourceType = (typeof eventDataCitations.$inferInsert)["sourceType"];

function sourceTypeFor(kind: CitationSource["kind"]): CitationSourceType {
  switch (kind) {
    case "url":
      // We fetched a page and read the value off it — NOT the sender's claim.
      //
      // The ticket asked for `direct_scrape`; this table's enum does not have
      // it (official_website | news_article | press_release | social_media |
      // user_submitted | other), and inventing a value would fail the column
      // constraint. `official_website` would over-claim — we cannot tell
      // generically whether a linked page is the organizer's own site.
      //
      // `other` is the honest bucket, and it buys the thing that actually
      // matters here: scraped values become DISTINGUISHABLE from typed ones, so
      // OPE-433 can grade them differently. Nothing ranks source_type today, so
      // separating the lanes is the whole ask.
      return "other";
    case "attachment":
    case "body":
      // The sender supplied these bytes directly — genuinely user_submitted.
      return "user_submitted";
  }
}

/**
 * OPE-457 scope 5 — refuse a citation the source provably cannot support.
 *
 * The specimen: a body containing only `https://vineyardartisans.com/` produced
 * a `start_date` citation of `2024-06-15` attributed to that body. The body has
 * no digits in it at all. The attribution is internally consistent — the body
 * source did emit the value — but the claim "this body says 2024-06-15" is
 * checkable, and false.
 *
 * Deliberately narrow. Only DATE fields, only BODY/ATTACHMENT sources, and only
 * when the supporting text contains no 4-digit year at all. A body that
 * mentions any year is left alone: partial-date prose ("the fair returns in
 * August") is normal, and this guard must not become a second extractor.
 *
 * Returns the offending field names, so the caller can log what it refused
 * rather than silently dropping rows.
 */
export function contradictedDateFields(
  fields: ReadonlyArray<{ fieldName: string; value: string }>,
  sourceKind: CitationSource["kind"],
  supportingText: string
): string[] {
  if (sourceKind === "url") return []; // the page is the evidence; we did not keep its text
  // No supporting text supplied → INERT. Absence of the body is not evidence
  // that the body lacked a date; firing here would drop good citations from
  // every caller that simply does not pass the text. (Caught by the existing
  // pipeline-citations tests, which omit it.)
  const text = (supportingText ?? "").trim();
  if (text.length === 0) return [];
  const hasAnyYear = /(?<!\d)(\d{4})(?!\d)/.test(text);
  if (hasAnyYear) return [];
  return fields
    .filter((f) => f.fieldName === "start_date" || f.fieldName === "end_date")
    .map((f) => f.fieldName);
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
    /** OPE-457 — the text a body/attachment citation claims to rest on, used
     *  by the contradiction guard. Omitted → guard is inert. */
    supportingText?: string;
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
      sourceType: sourceTypeFor(source.kind),
      confidence: confidenceToScore(extracted.fieldConfidence?.[f.confKey]),
      state: "active",
      createdBy: null,
    });
  }

  if (rows.length === 0) return 0;

  // OPE-457 scope 5 — drop date citations the supporting text cannot support.
  // Dropped rather than thrown: the event already exists and the NAME citation
  // is still good provenance, so failing the whole write would lose real
  // information to punish a bad neighbour.
  const contradicted = contradictedDateFields(
    rows.map((r) => ({ fieldName: r.fieldName as string, value: String(r.value) })),
    source.kind,
    args.supportingText ?? ""
  );
  const keep = rows.filter((r) => !contradicted.includes(r.fieldName as string));
  if (contradicted.length > 0) {
    console.warn(
      `[pipeline-citations] refusing ${contradicted.length} date citation(s) on event ${eventId}: ` +
        `attributed to a ${source.kind} source whose text contains no year (${contradicted.join(", ")})`
    );
  }
  if (keep.length === 0) return 0;
  await db.insert(eventDataCitations).values(keep);
  return keep.length;
}
