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
import { chunkIds } from "@takemetothefair/utils";
import { eventDataCitations } from "../schema.js";
import type { Db } from "../db.js";

/**
 * Citation rows per INSERT statement. See the chunked insert in
 * `recordSourceCitations` for why this is not "all of them at once".
 */
const CITATION_INSERT_CHUNK = 6;

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
    // OPE-744 — the numeric/date tracked fields the pipeline also carries.
    // `submit.ts`'s local ExtractedEvent declares the vendor-application family
    // explicitly (OPE-198); ticketPrice* is NOT declared there but still
    // arrives at runtime, because submitEvent forwards the extractor payload
    // with a blanket `...extracted.event` spread (submit.ts:662) and a
    // TypeScript interface is an annotation, not a runtime filter. The main
    // app's extractor does produce them (url-import/types.ts:42-44), the
    // submit schema accepts them (suggest-event/submit/schema.ts:34) and the
    // route writes them (route.ts:697). Optional here because any of them may
    // legitimately be absent.
    ticketPriceMin?: number | null;
    ticketPriceMax?: number | null;
    vendorFeeMin?: number | null;
    vendorFeeMax?: number | null;
    estimatedAttendance?: number | null;
    applicationDeadline?: string | null;
  };
  /** Per-field confidence from the extractor, keyed by the camelCase field
   *  name ("name", "startDate", "endDate", …). Sparsely populated. */
  fieldConfidence?: Record<string, "high" | "medium" | "low">;
}

/**
 * A numeric extracted value as the citation `value` string.
 *
 * `event_data_citations.value` is TEXT and the DENORM_FIELD_MAP parsers read it
 * back with `parseDollarsToCents` / `parseInt`, so the stored string must be the
 * plain number as the source stated it — money in DOLLARS, matching what the
 * extractor produced and what the submit route hands to `dollarsToCents`.
 *
 * 0 is a REAL value here (free admission is the single most common price on
 * this site — 13 of the 31 recently-created priced events are 0/0), so this
 * deliberately tests for null/undefined rather than falsiness.
 */
function numericValue(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined || !Number.isFinite(v)) return undefined;
  return String(v);
}

/**
 * Tracked ExtractedEvent fields → citation `field_name` (snake_case, matching
 * the DENORM_FIELD_MAP allow-list in admin-citations.ts) + the fieldConfidence
 * key.
 *
 * ⚠️ This list previously held only name/start_date/end_date, above a comment
 * asserting the layer "has no attendance / fee / ticket / deadline data". That
 * was false in two ways (OPE-744): `submit.ts`'s ExtractedEvent explicitly
 * declares the vendorFee / estimatedAttendance / applicationDeadline family,
 * and the ticket-price fields reach the database anyway through the untyped
 * `...extracted.event` spread at submit.ts:662. The comment is why
 * nobody added them — a wrong explanation is more durable than a missing one,
 * because it answers the question that would otherwise get asked.
 *
 * venue_id stays out on purpose: the pipeline has a venue NAME, not an id.
 */
const CITATION_FIELDS: ReadonlyArray<{
  fieldName: string;
  confKey: string;
  get: (e: ExtractedForCitations["event"]) => string | null | undefined;
}> = [
  { fieldName: "name", confKey: "name", get: (e) => e.name },
  { fieldName: "start_date", confKey: "startDate", get: (e) => e.startDate },
  { fieldName: "end_date", confKey: "endDate", get: (e) => e.endDate },
  {
    fieldName: "ticket_price_min",
    confKey: "ticketPriceMin",
    get: (e) => numericValue(e.ticketPriceMin),
  },
  {
    fieldName: "ticket_price_max",
    confKey: "ticketPriceMax",
    get: (e) => numericValue(e.ticketPriceMax),
  },
  {
    fieldName: "vendor_fee_min",
    confKey: "vendorFeeMin",
    get: (e) => numericValue(e.vendorFeeMin),
  },
  {
    fieldName: "vendor_fee_max",
    confKey: "vendorFeeMax",
    get: (e) => numericValue(e.vendorFeeMax),
  },
  {
    fieldName: "estimated_attendance",
    confKey: "estimatedAttendance",
    get: (e) => numericValue(e.estimatedAttendance),
  },
  {
    fieldName: "application_deadline",
    confKey: "applicationDeadline",
    get: (e) => e.applicationDeadline,
  },
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
 * Outcome of one citation write.
 *
 * ── Why this is not just a number ────────────────────────────────────────
 * OPE-540: every email-submitted event created on 2026-08-24 had zero
 * citations, and the investigation could not distinguish "this function was
 * never called" from "it was called and returned 0" from prod data — the
 * caller records nothing on success, and a bare `0` carries no reason. Five
 * separate causes all produced the identical observable.
 *
 * `reason` is null on success and otherwise names which branch returned zero.
 */
export interface CitationWriteResult {
  /** Rows actually inserted. */
  inserted: number;
  /** Why zero rows were written; null when `inserted > 0`. */
  reason:
    | "no-source-url"
    | "no-citeable-fields"
    | "all-fields-already-cited"
    | "all-fields-contradicted"
    | null;
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
): Promise<CitationWriteResult> {
  const { eventId, extracted, source, fromAddress } = args;
  const { sourceUrl, sourceName } = sourceIdentity(source, fromAddress, extracted);
  // A url-source with no URL has no provenance to attach — bail rather than
  // insert a NOT-NULL-violating empty source_url.
  if (!sourceUrl) return { inserted: 0, reason: "no-source-url" };

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

  if (rows.length === 0) {
    // Distinguishes "the extractor gave us nothing citeable" from "we already
    // had these" — the two are indistinguishable in a bare `0`, and that
    // ambiguity is what made OPE-540 undiagnosable from prod data.
    return {
      inserted: 0,
      reason: alreadyCited.size > 0 ? "all-fields-already-cited" : "no-citeable-fields",
    };
  }

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
  if (keep.length === 0) return { inserted: 0, reason: "all-fields-contradicted" };
  // OPE-744 — CHUNKED, and it must stay chunked.
  //
  // A multi-row Drizzle insert binds every column of every row in ONE
  // statement, and D1 refuses a statement with more than 100 bound parameters
  // (D1_MAX_BIND_PARAMS). `event_data_citations` binds ~13 per row here: the
  // ten set below plus the three `$defaultFn` columns (id, created_at,
  // updated_at) that Drizzle generates in JS and binds.
  //
  // While CITATION_FIELDS held three entries this could never exceed ~39 and a
  // single insert was safe. Widening it to nine (this ticket) takes the worst
  // case to ~117 — over the ceiling. The failure would have been INVISIBLE in
  // test: better-sqlite3 allows 32766 bound parameters, so every unit test
  // passes while production throws "too many SQL variables". Same family as
  // OPE-79/OPE-241/OPE-548.
  //
  // 6 rows ≈ 78 parameters, leaving headroom if a column is added to the table.
  // If you add fields to CITATION_FIELDS, this constant is the thing to check.
  for (const batch of chunkIds(keep, CITATION_INSERT_CHUNK)) {
    await db.insert(eventDataCitations).values(batch);
  }
  return { inserted: keep.length, reason: null };
}
