/**
 * OPE-175 — fill-empty-only enrichment proposals for dedup-on-match.
 *
 * When an inbound submission dedups to an EXISTING event, we don't mutate the
 * live (usually APPROVED) event. Instead we capture the subset of fields the
 * email could FILL that are currently empty, and stage them for operator review
 * (John's call 2026-07-13: fill-empty only, land PENDING). This module is the
 * pure decision — "which fields would we propose?" — so the fill-empty-only
 * invariant is unit-tested independently of the Durable-Object workflow.
 *
 * Invariant: a field is proposed ONLY when the existing value is empty AND the
 * incoming value is non-empty. A populated existing field is never proposed, so
 * curated data can never be overwritten by this path. NOTHING here writes to
 * `events` or `event_days` — the only writes are an `admin_actions` row and the
 * inbound row's `flagged_for_review` bit.
 *
 * OPE-1152 — the scope was `image_url` / `source_url` / `description` only, and
 * those are precisely the three fields that are always populated first on any
 * event mature enough to be matched against, so the writer staged ONE proposal
 * in its lifetime (prod, 2026-08-26). The scope now covers every field the
 * extractor (src/lib/url-import/types.ts `ExtractedEventData`) actually emits
 * that organizers send: hours, ticket url/prices, vendor fee terms, indoor/
 * outdoor, attendance, the application url/deadline/instructions, walk-ins and
 * categories. A match that stages nothing is no longer silent: it writes
 * `dedup.enrich_nothing_staged` naming what the email carried and why nothing
 * was staged, and flags the inbound row when content was dropped.
 *
 * NOT in scope because the extractor does not produce them (follow-up, not
 * invented here): `access_notes`, `pet_friendly`, performers. The roster is
 * linked on the keeper by OPE-847 on the multi-source path only.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { adminActions, eventDays, events, inboundEmails } from "../schema.js";
import type { Db } from "../db.js";

export const ENRICH_PROPOSED_ACTION = "dedup.enrich_proposed";
/** OPE-1152 — a match that staged zero proposals. One row per match, always. */
export const ENRICH_NOTHING_STAGED_ACTION = "dedup.enrich_nothing_staged";

const isEmpty = (v: string | null | undefined): boolean => v == null || v.trim().length === 0;

const INDOOR_OUTDOOR = new Set(["INDOOR", "OUTDOOR", "MIXED"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Existing event's current values for the enrichable fields. Every field is
 *  optional so older callers that know only the original three still work. */
export interface ExistingEnrichFields {
  imageUrl?: string | null;
  sourceUrl?: string | null;
  description?: string | null;
  ticketUrl?: string | null;
  ticketPriceMinCents?: number | null;
  ticketPriceMaxCents?: number | null;
  vendorFeeMinCents?: number | null;
  vendorFeeMaxCents?: number | null;
  vendorFeeNotes?: string | null;
  indoorOutdoor?: string | null;
  estimatedAttendance?: number | null;
  applicationUrl?: string | null;
  applicationDeadline?: Date | number | null;
  applicationInstructions?: string | null;
  walkInsAllowed?: boolean | null;
  /** The raw JSON column (`"[]"` when empty). */
  categories?: string | null;
  /** True when any event_days row of the event already carries an open time. */
  hasDayHours?: boolean;
}

/** Values carried by the inbound submission, in the EXTRACTOR's units
 *  (dollars, `YYYY-MM-DD`), as returned by /api/admin/import-url/extract. */
export interface IncomingEnrichFields {
  imageUrl?: string | null;
  sourceUrl?: string | null;
  description?: string | null;
  ticketUrl?: string | null;
  ticketPriceMin?: number | null;
  ticketPriceMax?: number | null;
  vendorFeeMin?: number | null;
  vendorFeeMax?: number | null;
  vendorFeeNotes?: string | null;
  indoorOutdoor?: string | null;
  estimatedAttendance?: number | null;
  applicationUrl?: string | null;
  applicationDeadline?: string | null;
  applicationInstructions?: string | null;
  walkInsAllowed?: boolean | null;
  categories?: string[] | null;
  startTime?: string | null;
  endTime?: string | null;
  hoursNotes?: string | null;
  dayHours?: unknown[] | null;
}

const toCents = (dollars: number | null | undefined): number | null =>
  typeof dollars === "number" && Number.isFinite(dollars) && dollars >= 0
    ? Math.round(dollars * 100)
    : null;

const nonNegInt = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;

const parseCategories = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const normText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** One enrichable field: its column key, the existing value's emptiness, the
 *  normalized incoming value (null = the email carried nothing), and whether
 *  the existing value already says the same thing. */
interface FieldCheck {
  col: string;
  existingEmpty: boolean;
  incoming: unknown;
  sameAsExisting: boolean;
}

function fieldChecks(existing: ExistingEnrichFields, incoming: IncomingEnrichFields): FieldCheck[] {
  const text = (col: string, cur: string | null | undefined, next: string | null | undefined) => {
    const inc = isEmpty(next) ? null : (next as string).trim();
    return {
      col,
      existingEmpty: isEmpty(cur),
      incoming: inc,
      sameAsExisting:
        inc != null &&
        !isEmpty(cur) &&
        // A description that is already contained in the curated copy is not
        // dropped content — it is the same content.
        normText(cur as string).includes(normText(inc)),
    };
  };
  const num = (col: string, cur: number | null | undefined, next: number | null) => ({
    col,
    existingEmpty: cur == null,
    incoming: next,
    sameAsExisting: next != null && cur === next,
  });

  const out: FieldCheck[] = [
    text("image_url", existing.imageUrl, incoming.imageUrl),
    text("source_url", existing.sourceUrl, incoming.sourceUrl),
    text("description", existing.description, incoming.description),
    text("ticket_url", existing.ticketUrl, incoming.ticketUrl),
    num("ticket_price_min_cents", existing.ticketPriceMinCents, toCents(incoming.ticketPriceMin)),
    num("ticket_price_max_cents", existing.ticketPriceMaxCents, toCents(incoming.ticketPriceMax)),
    num("vendor_fee_min_cents", existing.vendorFeeMinCents, toCents(incoming.vendorFeeMin)),
    num("vendor_fee_max_cents", existing.vendorFeeMaxCents, toCents(incoming.vendorFeeMax)),
    text("vendor_fee_notes", existing.vendorFeeNotes, incoming.vendorFeeNotes),
    num(
      "estimated_attendance",
      existing.estimatedAttendance,
      nonNegInt(incoming.estimatedAttendance)
    ),
    text("application_url", existing.applicationUrl, incoming.applicationUrl),
    text(
      "application_instructions",
      existing.applicationInstructions,
      incoming.applicationInstructions
    ),
  ];

  const io =
    typeof incoming.indoorOutdoor === "string" && INDOOR_OUTDOOR.has(incoming.indoorOutdoor)
      ? incoming.indoorOutdoor
      : null;
  out.push({
    col: "indoor_outdoor",
    existingEmpty: isEmpty(existing.indoorOutdoor),
    incoming: io,
    sameAsExisting: io != null && existing.indoorOutdoor === io,
  });

  const deadline =
    typeof incoming.applicationDeadline === "string" && ISO_DAY.test(incoming.applicationDeadline)
      ? incoming.applicationDeadline
      : null;
  out.push({
    col: "application_deadline",
    existingEmpty: existing.applicationDeadline == null,
    incoming: deadline,
    sameAsExisting: false,
  });

  const walkIns = typeof incoming.walkInsAllowed === "boolean" ? incoming.walkInsAllowed : null;
  out.push({
    col: "walk_ins_allowed",
    existingEmpty: existing.walkInsAllowed == null,
    incoming: walkIns,
    sameAsExisting: walkIns != null && existing.walkInsAllowed === walkIns,
  });

  const incCats = (incoming.categories ?? []).filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0
  );
  const curCats = parseCategories(existing.categories);
  out.push({
    col: "categories",
    existingEmpty: curCats.length === 0,
    incoming: incCats.length > 0 ? incCats : null,
    sameAsExisting: incCats.length > 0 && incCats.every((c) => curCats.includes(c)),
  });

  // Hours are staged as ONE proposal against event_days, never written: they
  // are the field this project has been burned on (OPE-479 — the MDI incident),
  // and event_days carry no provenance yet (OPE-433).
  const hours: Record<string, unknown> = {};
  if (!isEmpty(incoming.startTime)) hours.startTime = (incoming.startTime as string).trim();
  if (!isEmpty(incoming.endTime)) hours.endTime = (incoming.endTime as string).trim();
  if (!isEmpty(incoming.hoursNotes)) hours.hoursNotes = (incoming.hoursNotes as string).trim();
  if (Array.isArray(incoming.dayHours) && incoming.dayHours.length > 0)
    hours.dayHours = incoming.dayHours;
  out.push({
    col: "event_days.hours",
    existingEmpty: existing.hasDayHours !== true,
    incoming: Object.keys(hours).length > 0 ? hours : null,
    sameAsExisting: false,
  });

  return out;
}

export interface EnrichDisposition {
  /** Fill-empty proposals: existing empty AND incoming present. */
  proposals: Record<string, unknown>;
  /** Every field the email carried a value for. */
  extractedFields: string[];
  /** Carried, but NOT staged because the event already holds a DIFFERENT
   *  value. This is the content a fill-empty rule drops on the floor — what an
   *  operator should compare by hand. */
  unstagedFields: string[];
}

export function computeEnrichDisposition(
  existing: ExistingEnrichFields,
  incoming: IncomingEnrichFields
): EnrichDisposition {
  const proposals: Record<string, unknown> = {};
  const extractedFields: string[] = [];
  const unstagedFields: string[] = [];
  for (const f of fieldChecks(existing, incoming)) {
    if (f.incoming == null) continue;
    extractedFields.push(f.col);
    if (f.existingEmpty) proposals[f.col] = f.incoming;
    else if (!f.sameAsExisting) unstagedFields.push(f.col);
  }
  return { proposals, extractedFields, unstagedFields };
}

/** Map an extractor event (+ submission URL) onto the incoming shape. */
export function incomingFromExtracted(
  url: string | null | undefined,
  event: Record<string, unknown>
): IncomingEnrichFields {
  const s = (k: string) => (typeof event[k] === "string" ? (event[k] as string) : null);
  const n = (k: string) => (typeof event[k] === "number" ? (event[k] as number) : null);
  return {
    imageUrl: s("imageUrl"),
    sourceUrl: url || null,
    description: s("description"),
    ticketUrl: s("ticketUrl"),
    ticketPriceMin: n("ticketPriceMin"),
    ticketPriceMax: n("ticketPriceMax"),
    vendorFeeMin: n("vendorFeeMin"),
    vendorFeeMax: n("vendorFeeMax"),
    vendorFeeNotes: s("vendorFeeNotes"),
    indoorOutdoor: s("indoorOutdoor"),
    estimatedAttendance: n("estimatedAttendance"),
    applicationUrl: s("applicationUrl"),
    applicationDeadline: s("applicationDeadline"),
    applicationInstructions: s("applicationInstructions"),
    walkInsAllowed: typeof event.walkInsAllowed === "boolean" ? event.walkInsAllowed : null,
    categories: Array.isArray(event.categories) ? (event.categories as string[]) : null,
    startTime: s("startTime"),
    endTime: s("endTime"),
    hoursNotes: s("hoursNotes"),
    dayHours: Array.isArray(event.dayHours) ? (event.dayHours as unknown[]) : null,
  };
}

/** Which match branch reached the stager — recorded so a future "only one
 *  branch ever writes" (the OPE-627 / OPE-1152 shape) is visible by GROUP BY. */
export type EnrichMatchPath =
  | "single-high" // submitExtractedEvent HIGH tier → already-exists reply
  | "fanout" // one page, N events, a child matched
  | "multi-source" // body + URLs, a candidate matched
  | "multi-url" // N URLs, one matched
  | "occurrence-exists" // submit route: the edition already exists under its series
  | "possible-duplicate"; // submit route created a PENDING row tagged possible_duplicate_of

export interface StageEnrichInput {
  existingEventId: string;
  url: string | null | undefined;
  event: Record<string, unknown>;
  matchType: string | null;
  path: EnrichMatchPath;
  inboundEmailId: string | null;
  fromAddress: string | null;
}

export type StageEnrichOutcome =
  | { outcome: "proposed"; disposition: EnrichDisposition }
  | { outcome: "nothing-staged"; disposition: EnrichDisposition; flagged: boolean }
  | { outcome: "event-missing" };

/**
 * Stage enrich-on-match for one matched submission. Writes exactly ONE
 * `admin_actions` row per match (proposed, or nothing-staged) so every match is
 * accounted for, and flags the inbound row when there is something for a human
 * to look at: a proposal, or content the fill-empty rule had to drop.
 *
 * Never mutates `events` / `event_days`. Throws on DB failure — callers wrap it
 * fail-soft (a staging hiccup must never fail a submission or its reply).
 */
export async function stageEnrichOnMatch(
  db: Db,
  input: StageEnrichInput
): Promise<StageEnrichOutcome> {
  const [existing] = await db
    .select({
      imageUrl: events.imageUrl,
      sourceUrl: events.sourceUrl,
      description: events.description,
      ticketUrl: events.ticketUrl,
      ticketPriceMinCents: events.ticketPriceMinCents,
      ticketPriceMaxCents: events.ticketPriceMaxCents,
      vendorFeeMinCents: events.vendorFeeMinCents,
      vendorFeeMaxCents: events.vendorFeeMaxCents,
      vendorFeeNotes: events.vendorFeeNotes,
      indoorOutdoor: events.indoorOutdoor,
      estimatedAttendance: events.estimatedAttendance,
      applicationUrl: events.applicationUrl,
      applicationDeadline: events.applicationDeadline,
      applicationInstructions: events.applicationInstructions,
      walkInsAllowed: events.walkInsAllowed,
      categories: events.categories,
    })
    .from(events)
    .where(eq(events.id, input.existingEventId))
    .limit(1);
  if (!existing) return { outcome: "event-missing" };

  const [hoursRow] = await db
    .select({ id: eventDays.id })
    .from(eventDays)
    .where(and(eq(eventDays.eventId, input.existingEventId), isNotNull(eventDays.openTime)))
    .limit(1);

  const disposition = computeEnrichDisposition(
    { ...existing, hasDayHours: !!hoursRow },
    incomingFromExtracted(input.url, input.event)
  );
  const proposed = Object.keys(disposition.proposals).length > 0;
  // Flag when a human has something to do: review a proposal, or compare the
  // content that was carried but could not be staged. A match whose email
  // carried nothing new (or only what the event already says) is recorded but
  // not flagged — flagging it would be queue noise.
  const flag = proposed || disposition.unstagedFields.length > 0;

  await db.insert(adminActions).values({
    action: proposed ? ENRICH_PROPOSED_ACTION : ENRICH_NOTHING_STAGED_ACTION,
    actorUserId: null,
    targetType: "event",
    targetId: input.existingEventId,
    payloadJson: JSON.stringify({
      ...(proposed ? { proposals: disposition.proposals } : {}),
      extractedFields: disposition.extractedFields,
      unstagedFields: disposition.unstagedFields,
      matchType: input.matchType ?? null,
      path: input.path,
      source: input.url || null,
      inboundEmailId: input.inboundEmailId,
      fromAddress: input.fromAddress,
    }),
    createdAt: new Date(),
  });

  if (flag && input.inboundEmailId) {
    // SET only — never clears an operator's own flag.
    await db
      .update(inboundEmails)
      .set({ flaggedForReview: 1 })
      .where(eq(inboundEmails.id, input.inboundEmailId));
  }

  return proposed
    ? { outcome: "proposed", disposition }
    : { outcome: "nothing-staged", disposition, flagged: flag };
}
