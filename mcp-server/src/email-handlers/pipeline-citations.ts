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
import { chunkIds, classifyDomainTier } from "@takemetothefair/utils";
import { eventDataCitations } from "../schema.js";
import type { Db } from "../db.js";

/**
 * Citation rows per INSERT statement. See the chunked insert in
 * `recordSourceCitations` for why this is not "all of them at once".
 */
const CITATION_INSERT_CHUNK = 5;

/**
 * OPE-838 scope 4 — how much of the fetched page to keep in `source_excerpt`.
 *
 * OPE-692 added the column so a citation can be judged without re-fetching a
 * URL nothing can reach. 600 chars is enough to recognise the page and see the
 * lede; it is not a copy of the page, and `source_content_hash` is what detects
 * a later edit.
 *
 * ⚠️ This excerpt is PAGE-level, not field-level. Every citation from one fetch
 * carries the same leading text, because the extractor returns values without
 * the spans it read them from. A per-field supporting span is OPE-465's job
 * (the grounding verifier), and this deliberately does not pretend to be one.
 */
const EXCERPT_MAX_CHARS = 600;

/**
 * A page we actually fetched, captured at extract time.
 *
 * The evidence is only cheap at this moment: the workflow holds the title and
 * body text of the page it just read, and by the time anyone asks "what did
 * that source say?" the page may have changed or gone. Everything here is
 * PAGE-level — see the EXCERPT_MAX_CHARS note.
 */
export interface SourceSnapshot {
  /** `<title>` of the fetched page, or null when the fetch returned none. */
  title: string | null;
  /** Extracted text content of the page. Truncated into `source_excerpt`. */
  text: string;
  /** When the fetch completed. */
  fetchedAt: Date;
}

/**
 * SHA-256 of the fetched page text, lowercase hex.
 *
 * `crypto.subtle` is available on the Workers runtime; this is the same digest
 * shape `admin-citations.ts` stores from the agent-edit path, so a hash written
 * here is comparable with one written there.
 */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
    // OPE-838 scope 5 — the fields that distinguish a real extraction from the
    // OPE-537 fabrication shape. Both are produced by the extractor and were
    // written to the event while being cited nowhere.
    description?: string | null;
    venueName?: string | null;
    startTime?: string | null;
    endTime?: string | null;
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
 * ⚠️ `venue_id` stays out, and that is NOT the same statement as "the venue is
 * uncited" (OPE-838 scope 5). This layer holds a venue NAME; the id is minted
 * downstream by `autoLinkVenue`, so a `venue_id` citation written here would
 * attribute an identifier the source never stated. `venue_name` is what the
 * page actually said, so that is what gets cited. Hours are likewise absent:
 * The event's HOURS are cited, as `start_time` / `end_time` — the shape the
 * extractor produces. The denormalized hours live in `event_days`, which this
 * helper never sees; what is cited here is what the SOURCE said, which is the
 * thing provenance is for.
 */
const CITATION_FIELDS: ReadonlyArray<{
  fieldName: string;
  confKey: string;
  get: (e: ExtractedForCitations["event"]) => string | null | undefined;
}> = [
  { fieldName: "name", confKey: "name", get: (e) => e.name },
  { fieldName: "start_date", confKey: "startDate", get: (e) => e.startDate },
  { fieldName: "end_date", confKey: "endDate", get: (e) => e.endDate },
  { fieldName: "description", confKey: "description", get: (e) => e.description },
  { fieldName: "venue_name", confKey: "venueName", get: (e) => e.venueName },
  // The ticket asked for "hours". The extractor carries them as two fields, and
  // that is how the source stated them, so they are cited as two rather than
  // concatenated into a display string nothing can parse back.
  { fieldName: "start_time", confKey: "startTime", get: (e) => e.startTime },
  { fieldName: "end_time", confKey: "endTime", get: (e) => e.endTime },
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

/**
 * OPE-838 scope 2 — `official_website` when, and only when, something
 * INDEPENDENT of the fetch says the page belongs to the organizer.
 *
 * ⚠️ The ticket asked for a different rule: *"when the fetched URL's
 * registrable domain is the event's own `source_domain`, that is
 * `official_website`."* **That test is circular and always true here.**
 * `events.source_domain` is derived from the very URL the citation is
 * attributed to — `src/app/api/suggest-event/submit/route.ts:712` sets
 * `sourceDomain: classifySource(sourceName, data.sourceUrl).sourceDomain`, and
 * `data.sourceUrl` is the fetched URL. Implementing it literally would stamp
 * `official_website` on every scraped page including aggregators, which is
 * exactly the over-claim OPE-457 rejected on the record.
 *
 * `classifyDomainTier` is the non-circular version of the same intent. T1 means
 * the page's registrable domain matches a signal that did NOT come from the
 * fetch — today, the submitting sender's own email domain. An organizer mailing
 * us their own festival site clears it; a stranger forwarding an aggregator
 * link does not, and stays `other`.
 *
 * Deliberately conservative in one direction: a genuine organizer site
 * submitted from a gmail address is still `other`. That understates the source,
 * which is the failure this ticket is about — but the alternative is asserting
 * an origin we cannot evidence, and a provenance field that over-claims is
 * worse than one that under-claims, because nothing downstream can tell.
 */
function sourceTypeFor(
  kind: CitationSource["kind"],
  ctx: { sourceUrl: string; fromAddress: string }
): CitationSourceType {
  switch (kind) {
    case "url": {
      // The sender's email domain is evidence about the page ONLY because it
      // was not derived from the page. That independence is the whole point.
      const at = ctx.fromAddress.lastIndexOf("@");
      const senderDomain = at >= 0 ? ctx.fromAddress.slice(at + 1).toLowerCase() : null;
      const tier = classifyDomainTier(ctx.sourceUrl, { contactEmailDomain: senderDomain });
      // T2 (DMO / .gov / chamber) is real but is NOT the organizer, and this
      // enum has no bucket for it. `other` remains the honest answer there.
      return tier === "T1" ? "official_website" : "other";
    }
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
    /** OPE-838 scope 3/4 — the page this url-source was read from. Omitted →
     *  the snapshot columns stay null, exactly as before this ticket. */
    snapshot?: SourceSnapshot;
    /** OPE-837 — camelCase field keys this source did NOT produce, because the
     *  same-site crawl filled them from a DIFFERENT page. Excluded here and
     *  cited separately against the page they were actually read from, so a
     *  citation never claims the primary page stated something it does not
     *  contain (the OPE-457 false-attribution class). */
    excludeConfKeys?: readonly string[];
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

  // OPE-838 scope 3/4 — what the source SAID, captured at the only moment it is
  // cheap. Computed once per call, not per row: the digest is over the page.
  //
  // ⚠️ `source_verifiable` is NOT a column and is not set here. It is DERIVED at
  // read time — `admin-citations.ts:881` returns
  // `Boolean(sourceTitle || sourceExcerpt || sourceContentHash)`. So the
  // `source_verifiable: false` this ticket reported as an inverted flag was an
  // honest report that no snapshot existed. Populating these three fields is
  // what makes it true; there is nothing else to flip.
  //
  // Only for url-sources. A body/attachment citation's "source" is the email
  // itself, which is already stored on `inbound_emails` — re-copying it here
  // would duplicate it into a second table under a name that implies a fetch.
  const snap =
    source.kind === "url" && args.snapshot
      ? {
          sourceTitle: args.snapshot.title,
          sourceExcerpt: args.snapshot.text.trim().slice(0, EXCERPT_MAX_CHARS) || null,
          sourceContentHash: args.snapshot.text ? await sha256Hex(args.snapshot.text) : null,
          sourceFetchedAt: args.snapshot.fetchedAt,
        }
      : null;

  const rows: (typeof eventDataCitations.$inferInsert)[] = [];
  for (const f of CITATION_FIELDS) {
    if (args.excludeConfKeys?.includes(f.confKey)) continue;
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
      sourceType: sourceTypeFor(source.kind, { sourceUrl, fromAddress }),
      confidence: confidenceToScore(extracted.fieldConfidence?.[f.confKey]),
      state: "active",
      createdBy: null,
      ...snap,
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
  // (D1_MAX_BIND_PARAMS). The failure is INVISIBLE in test: better-sqlite3
  // allows 32766 bound parameters, so every unit test passes while production
  // throws "too many SQL variables". Same family as OPE-79/OPE-241/OPE-548.
  //
  // ⚠️ The binding cost is per ROW-SHAPE, not per field. Two things move it,
  // and OPE-838 moved the second one for the first time:
  //
  //   * CITATION_FIELDS length → how many ROWS (3 → 9 in OPE-744, 13 here).
  //   * columns set per row    → how many PARAMETERS EACH ROW BINDS.
  //
  // Per row today: 10 set explicitly below, 3 `$defaultFn` columns Drizzle
  // generates in JS and binds (id, created_at, updated_at), and 4 more from the
  // OPE-838 snapshot spread (source_title, source_excerpt, source_content_hash,
  // source_fetched_at) = **17**.
  //
  // At the old chunk of 6 that is 6 × 17 = **102, over the ceiling** — a live
  // D1 failure introduced by adding columns while the row COUNT stayed legal.
  // 5 × 17 = 85, with headroom for one more column.
  //
  // If you add fields to CITATION_FIELDS **or columns to the row**, this
  // constant is the thing to check — and the OPE-744 param-cap test must
  // exercise the widest shape (it now passes a snapshot for exactly that
  // reason; without one it counts 13/row and goes green on a statement
  // production would reject).
  for (const batch of chunkIds(keep, CITATION_INSERT_CHUNK)) {
    await db.insert(eventDataCitations).values(batch);
  }
  return { inserted: keep.length, reason: null };
}
