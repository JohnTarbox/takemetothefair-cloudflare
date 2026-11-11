/**
 * OPE-1618 — preview and commit a promoter's season spreadsheet.
 *
 * PREVIEW writes nothing. Each row is one of:
 *   - `error`            — what is wrong, by column (rows.ts);
 *   - `already_imported` — this file's row was committed before (ledger hit);
 *   - `match`            — dedup found THIS promoter's own event; the fields
 *                          the row would change are listed;
 *   - `new`              — no existing event; committing creates one.
 * A row that matches ANOTHER organizer's event is an error: a promoter can
 * import only to its own listings.
 *
 * COMMIT takes the rows the promoter ticked, re-runs the preview for them (so
 * a stale browser cannot commit a row that has since changed category), and:
 *   - `new`   → inserts a PENDING event (review), exactly as the portal's own
 *               create form does, with every value cited to the upload;
 *   - `match` → writes NOTHING to the event. Portal edits of a live listing are
 *               requests (OPE-1514 option D), so the differences are staged on
 *               the ledger row and the event gets a `promoter_import_update`
 *               review flag for an operator.
 * The ledger's UNIQUE(promoter, file hash, row) makes a re-upload a no-op.
 *
 * QUERY BUDGET. A D1 invocation allows ~1,000 queries, and a row costs ~5 to
 * preview and ~15 to commit, so callers page: at most PREVIEW_PAGE rows per
 * preview call and COMMIT_PAGE per commit call (the UI and the operator tool
 * loop). Citation inserts are chunked under D1's 100-bound-parameter cap.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  eventDataCitations,
  events,
  promoterImportRows,
  raiseEventReviewFlag,
  type CitationProvenanceKind,
} from "@/lib/db/schema";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { detectPossibleDuplicate } from "@/lib/duplicates/venue-date-collision";
import { autoLinkVenue } from "@/lib/venue-matching";
import { checkEventVenue } from "@/lib/venues/former-venue-guard";
import { attachEventToSeries } from "@/lib/series/resolve-or-create-series";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { insertEventDaysBatched, resolveUniqueEventSlug } from "@/lib/events/insert-helpers";
import { normalizeEventDate } from "@/lib/event-dates";
import { createSlug, dollarsToCents } from "@/lib/utils";
import { partitionEventCategories } from "@takemetothefair/constants";
import { rowDays, type ImportRow } from "./rows";

type Db = ReturnType<typeof getCloudflareDb>;

export const PREVIEW_PAGE = 50;
export const COMMIT_PAGE = 25;
/** Citation rows per INSERT: 13 bound columns × 7 = 91 < D1's 100. */
export const CITATION_CHUNK = 7;

export type RowStatus = "error" | "already_imported" | "match" | "new";

export interface PreviewRow {
  row: number;
  status: RowStatus;
  name: string | null;
  start_date: string | null;
  errors: string[];
  /** Non-blocking notes, e.g. a category left off (OPE-1058 allow-list). */
  warnings: string[];
  /** For match / already_imported: the event. */
  event?: { id: string; slug: string; name: string; status: string };
  match_type?: string;
  /** For match: what the row would change, field → { current, proposed }. */
  changes?: Record<string, { current: string | null; proposed: string | null }>;
}

const ymd = (d: Date | null | undefined) =>
  d instanceof Date && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
const centsToStr = (c: number | null | undefined) =>
  c === null || c === undefined ? null : (c / 100).toFixed(2);
const dollarsToStr = (d: number | null) => (d === null ? null : d.toFixed(2));

/** The comparable fields: what the row says vs what the event holds. */
export async function diffAgainstEvent(
  db: Db,
  eventId: string,
  v: NonNullable<ImportRow["value"]>
) {
  const [e] = await db
    .select({
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      description: events.description,
      applicationUrl: events.applicationUrl,
      applicationDeadline: events.applicationDeadline,
      vendorFeeMinCents: events.vendorFeeMinCents,
      vendorFeeMaxCents: events.vendorFeeMaxCents,
      ticketPriceMinCents: events.ticketPriceMinCents,
      ticketPriceMaxCents: events.ticketPriceMaxCents,
      sourceUrl: events.sourceUrl,
      imageUrl: events.imageUrl,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!e) return {};
  const pairs: Array<[string, string | null, string | null]> = [
    ["name", e.name, v.name],
    ["start_date", ymd(e.startDate), v.startDate],
    ["end_date", ymd(e.endDate), v.endDate],
    ["description", e.description, v.description],
    ["vendor_application_url", e.applicationUrl, v.applicationUrl],
    ["application_deadline", ymd(e.applicationDeadline), v.applicationDeadline],
    ["booth_fee_min", centsToStr(e.vendorFeeMinCents), dollarsToStr(v.vendorFeeMin)],
    ["booth_fee_max", centsToStr(e.vendorFeeMaxCents), dollarsToStr(v.vendorFeeMax)],
    ["admission_min", centsToStr(e.ticketPriceMinCents), dollarsToStr(v.ticketPriceMin)],
    ["admission_max", centsToStr(e.ticketPriceMaxCents), dollarsToStr(v.ticketPriceMax)],
    ["event_url", e.sourceUrl, v.eventUrl],
    ["image_url", e.imageUrl, v.imageUrl],
  ];
  const out: Record<string, { current: string | null; proposed: string | null }> = {};
  for (const [f, cur, prop] of pairs) {
    // A blank cell proposes nothing — it never asks to clear a field.
    if (prop === null) continue;
    if ((cur ?? "").trim() !== prop.trim()) out[f] = { current: cur, proposed: prop };
  }
  return out;
}

export async function previewRows(
  db: Db,
  args: { promoterId: string; fileHash: string; rows: ImportRow[] }
): Promise<PreviewRow[]> {
  if (args.rows.length > PREVIEW_PAGE)
    throw new Error(`preview at most ${PREVIEW_PAGE} rows per call`);
  const nums = args.rows.map((r) => r.rowNumber);
  const done = nums.length
    ? await db
        .select({ rowNumber: promoterImportRows.rowNumber, eventId: promoterImportRows.eventId })
        .from(promoterImportRows)
        .where(
          and(
            eq(promoterImportRows.promoterId, args.promoterId),
            eq(promoterImportRows.fileHash, args.fileHash),
            inArray(promoterImportRows.rowNumber, nums)
          )
        )
    : [];
  const doneBy = new Map(done.map((d) => [d.rowNumber, d.eventId]));
  const out: PreviewRow[] = [];
  for (const r of args.rows) {
    const base = {
      row: r.rowNumber,
      name: r.raw.name ?? null,
      start_date: r.value?.startDate ?? r.raw.start_date ?? null,
      warnings: r.warnings,
    };
    if (doneBy.has(r.rowNumber)) {
      out.push({
        ...base,
        status: "already_imported",
        errors: [],
        event: await eventRef(db, doneBy.get(r.rowNumber) ?? null),
      });
      continue;
    }
    if (!r.value) {
      out.push({ ...base, status: "error", errors: r.errors });
      continue;
    }
    const v = r.value;
    const dup = await findDuplicate(db, {
      sourceUrl: v.eventUrl,
      name: v.name,
      startDate: v.startDate,
      venueName: v.venueName,
      venueAddress: v.address,
      venueCity: v.city,
      venueState: v.state,
    });
    if (dup.isDuplicate && dup.identifiesSameEvent) {
      const [owner] = await db
        .select({ promoterId: events.promoterId })
        .from(events)
        .where(eq(events.id, dup.existingEvent.id))
        .limit(1);
      const ev = {
        id: dup.existingEvent.id,
        slug: dup.existingEvent.slug,
        name: dup.existingEvent.name,
        status: dup.existingEvent.status,
      };
      if (owner?.promoterId !== args.promoterId) {
        out.push({
          ...base,
          status: "error",
          errors: [
            `This matches "${ev.name}", which another organizer lists. Email us if it is yours.`,
          ],
          event: ev,
          match_type: dup.matchType,
        });
        continue;
      }
      out.push({
        ...base,
        status: "match",
        errors: [],
        event: ev,
        match_type: dup.matchType,
        changes: await diffAgainstEvent(db, ev.id, v),
      });
      continue;
    }
    out.push({ ...base, status: "new", errors: [] });
  }
  return out;
}

async function eventRef(db: Db, id: string | null) {
  if (!id) return undefined;
  const [e] = await db
    .select({ id: events.id, slug: events.slug, name: events.name, status: events.status })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  return e ?? undefined;
}

export interface CommitResult {
  row: number;
  outcome: "created" | "update_staged" | "skipped";
  event_id?: string;
  reason?: string;
}

export interface CommitContext {
  promoterId: string;
  fileHash: string;
  fileName: string | null;
  uploadedBy: string | null;
  channel: "portal" | "operator" | "api";
  now: Date;
  /**
   * OPE-1620 — who the citations name, when it is not a spreadsheet upload (the
   * promoter API: its key_id and external_id). Omitted → the upload defaults.
   */
  source?: {
    url: string;
    name: string;
    provenanceKind: CitationProvenanceKind;
    notes: Record<string, unknown>;
  };
}

const citationSource = (ctx: CommitContext, row: number) =>
  // Not fetchable on purpose: the evidence is the upload, recorded in notes.
  ctx.source?.url ?? `promoter-upload:sha256:${ctx.fileHash}#row=${row}`;
const citationName = (ctx: CommitContext) => ctx.source?.name ?? "Promoter spreadsheet upload";

export async function commitRows(
  db: Db,
  ctx: CommitContext,
  rows: ImportRow[],
  selected: Set<number>
): Promise<CommitResult[]> {
  const chosen = rows.filter((r) => selected.has(r.rowNumber));
  if (chosen.length > COMMIT_PAGE) throw new Error(`commit at most ${COMMIT_PAGE} rows per call`);
  const preview = await previewRows(db, {
    promoterId: ctx.promoterId,
    fileHash: ctx.fileHash,
    rows: chosen,
  });
  const out: CommitResult[] = [];
  for (const p of preview) {
    const r = chosen.find((x) => x.rowNumber === p.row)!;
    if (p.status === "error" || p.status === "already_imported" || !r.value) {
      out.push({
        row: p.row,
        outcome: "skipped",
        event_id: p.event?.id,
        reason: p.status === "error" ? p.errors.join(" ") : p.status,
      });
      continue;
    }
    if (p.status === "match") {
      out.push(await stageUpdate(db, ctx, r, p));
      continue;
    }
    out.push(await createEvent(db, ctx, r));
  }
  return out;
}

async function recordLedger(
  db: Db,
  ctx: CommitContext,
  r: ImportRow,
  outcome: "created" | "update_staged" | "cancel_staged",
  eventId: string | null,
  proposed: PreviewRow["changes"] | null
): Promise<boolean> {
  // ON CONFLICT DO NOTHING: two concurrent commits of the same row → one ledger
  // row; the loser reports "skipped" instead of double-creating.
  const res = await db
    .insert(promoterImportRows)
    .values({
      promoterId: ctx.promoterId,
      fileHash: ctx.fileHash,
      fileName: ctx.fileName,
      rowNumber: r.rowNumber,
      outcome,
      eventId,
      rowValues: JSON.stringify(r.raw),
      proposedChanges: proposed ? JSON.stringify(proposed) : null,
      uploadedBy: ctx.uploadedBy,
      channel: ctx.channel,
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: promoterImportRows.id });
  return res.length > 0;
}

/**
 * OPE-1620 — stage a row against an event the caller already resolved (the
 * promoter API's own external_id → event ref), skipping dedup: a ref names the
 * event even when the row renames or re-dates it. Same write as an import match.
 */
export async function stageUpdateForEvent(
  db: Db,
  ctx: CommitContext,
  r: ImportRow,
  eventId: string
): Promise<CommitResult & { changes: NonNullable<PreviewRow["changes"]> }> {
  const changes = r.value ? await diffAgainstEvent(db, eventId, r.value) : {};
  const res = await stageUpdate(db, ctx, r, {
    row: r.rowNumber,
    status: "match",
    name: r.raw.name ?? null,
    start_date: r.value?.startDate ?? null,
    errors: [],
    warnings: r.warnings,
    event: { id: eventId, slug: "", name: "", status: "" },
    changes,
  });
  return { ...res, changes };
}

/**
 * OPE-1620 — a promoter's request to cancel its event. Never a write to the
 * event: the request is staged (outcome `cancel_staged`, proposed status
 * CANCELLED + the reason) and the event gets a `promoter_cancel_request` flag.
 * Returns false when this ledger key was already used.
 */
export async function stageCancellation(
  db: Db,
  ctx: CommitContext,
  eventId: string,
  currentStatus: string,
  reason: string | null
): Promise<boolean> {
  const row: ImportRow = {
    rowNumber: 1,
    raw: {},
    errors: [],
    fieldErrors: [],
    warnings: [],
    value: null,
  };
  const proposed = {
    status: { current: currentStatus, proposed: "CANCELLED" },
    ...(reason ? { reason: { current: null, proposed: reason } } : {}),
  };
  if (!(await recordLedger(db, ctx, row, "cancel_staged", eventId, proposed))) return false;
  await raiseEventReviewFlag(db, eventId, "promoter_cancel_request", ctx.uploadedBy);
  return true;
}

async function stageUpdate(
  db: Db,
  ctx: CommitContext,
  r: ImportRow,
  p: PreviewRow
): Promise<CommitResult> {
  const eventId = p.event!.id;
  const changes = p.changes ?? {};
  if (!(await recordLedger(db, ctx, r, "update_staged", eventId, changes)))
    return { row: r.rowNumber, outcome: "skipped", event_id: eventId, reason: "already_imported" };
  if (Object.keys(changes).length)
    await raiseEventReviewFlag(db, eventId, "promoter_import_update", ctx.uploadedBy);
  return { row: r.rowNumber, outcome: "update_staged", event_id: eventId };
}

/** Exported for OPE-1620's API, which resolves "new" itself; callers run previewRows first. */
export async function createEvent(db: Db, ctx: CommitContext, r: ImportRow): Promise<CommitResult> {
  const v = r.value!;
  const baseSlug = createSlug(v.name);
  if (!baseSlug)
    return {
      row: r.rowNumber,
      outcome: "skipped",
      reason: "Event name must contain letters or numbers.",
    };
  const venue = await autoLinkVenue(db, {
    venueName: v.venueName,
    venueAddress: v.address,
    venueCity: v.city,
    venueState: v.state,
  });
  const venueId = venue.venueId;
  const start = normalizeEventDate(v.startDate);
  const end = normalizeEventDate(v.endDate);
  const formerVenue = await checkEventVenue(db, venueId, end ?? start);
  if (formerVenue.kind === "refuse")
    return { row: r.rowNumber, outcome: "skipped", reason: formerVenue.message };

  // Claim the ledger row FIRST: a concurrent commit of the same row loses here
  // and creates nothing. The event id is filled in once the event exists (the
  // column is an FK, so it cannot name a row not yet inserted).
  if (!(await recordLedger(db, ctx, r, "created", null, null)))
    return { row: r.rowNumber, outcome: "skipped", reason: "already_imported" };
  const eventId = crypto.randomUUID();

  const slug = await resolveUniqueEventSlug(db, baseSlug);
  const possibleDuplicateOf = await detectPossibleDuplicate(db, {
    venueId,
    startDate: start,
    endDate: end,
    name: v.name,
    promoterId: ctx.promoterId,
  });
  await db.insert(events).values({
    id: eventId,
    possibleDuplicateOf,
    name: v.name,
    slug,
    description: v.description,
    venueId,
    stateCode: v.state,
    promoterId: ctx.promoterId,
    // Same stance as the portal's create form (OPE-433): the organizer's own
    // entry, so dates are confirmed and a scraper must not overwrite it.
    datesConfirmed: true,
    syncEnabled: false,
    startDate: start,
    endDate: end,
    // OPE-1058 — the shared allow-list, applied at the write itself (rows.ts
    // already partitioned; re-applying here keeps this writer self-evidently safe).
    categories: JSON.stringify(partitionEventCategories(v.categories).kept),
    tags: JSON.stringify([]),
    sourceUrl: v.eventUrl,
    ticketPriceMinCents: dollarsToCents(v.ticketPriceMin),
    ticketPriceMaxCents: dollarsToCents(v.ticketPriceMax),
    imageUrl: v.imageUrl,
    status: "PENDING",
    vendorFeeMinCents: dollarsToCents(v.vendorFeeMin),
    // A single fee in the sheet is both ends of the range on a NEW event.
    vendorFeeMaxCents: dollarsToCents(v.vendorFeeMax ?? v.vendorFeeMin),
    applicationDeadline: normalizeEventDate(v.applicationDeadline),
    applicationUrl: v.applicationUrl,
  });
  await db
    .update(promoterImportRows)
    .set({ eventId })
    .where(
      and(
        eq(promoterImportRows.promoterId, ctx.promoterId),
        eq(promoterImportRows.fileHash, ctx.fileHash),
        eq(promoterImportRows.rowNumber, r.rowNumber)
      )
    );
  if (formerVenue.kind === "flag") await raiseEventReviewFlag(db, eventId, "former_venue");
  await attachEventToSeries(db, eventId, { name: v.name, venueId, promoterId: ctx.promoterId });
  const source = {
    sourceUrl: citationSource(ctx, r.rowNumber),
    sourceName: citationName(ctx),
    sourceType: "user_submitted" as const,
    createdBy: ctx.uploadedBy,
  };
  await insertEventDaysBatched(
    db,
    eventId,
    v.hours ? rowDays(v) : [],
    ctx.uploadedBy ?? `promoter-import:${ctx.channel}`,
    v.hours ? source : undefined
  );
  await recomputeEventCompleteness(db, eventId);
  await citeRow(
    db,
    ctx,
    r,
    eventId,
    venue.venueId
      ? null
      : [v.venueName, v.address, v.city, v.state, v.zip].filter(Boolean).join(", ")
  );
  return { row: r.rowNumber, outcome: "created", event_id: eventId };
}

/** One citation per value the row supplied, provenance `promoter_portal`, chunked under the bind cap. */
async function citeRow(
  db: Db,
  ctx: CommitContext,
  r: ImportRow,
  eventId: string,
  unmatchedVenue: string | null
) {
  const v = r.value!;
  const year = Number(v.startDate.slice(0, 4));
  const fields: Array<[string, string | null]> = [
    ["name", v.name],
    ["start_date", v.startDate],
    ["end_date", v.endDate],
    [
      "venue",
      unmatchedVenue ?? ([v.venueName, v.city, v.state].filter(Boolean).join(", ") || null),
    ],
    ["hours", v.hours ? `${v.hours.open}-${v.hours.close}` : null],
    ["description", v.description],
    [
      "ticket_price_min_cents",
      v.ticketPriceMin === null ? null : String(dollarsToCents(v.ticketPriceMin)),
    ],
    [
      "ticket_price_max_cents",
      v.ticketPriceMax === null ? null : String(dollarsToCents(v.ticketPriceMax)),
    ],
    ["application_url", v.applicationUrl],
    ["application_deadline", v.applicationDeadline],
    [
      "vendor_fee_min_cents",
      v.vendorFeeMin === null ? null : String(dollarsToCents(v.vendorFeeMin)),
    ],
    [
      "vendor_fee_max_cents",
      (v.vendorFeeMax ?? v.vendorFeeMin) === null
        ? null
        : String(dollarsToCents(v.vendorFeeMax ?? v.vendorFeeMin)),
    ],
    ["source_url", v.eventUrl],
    ["image_url", v.imageUrl],
  ];
  const notes = JSON.stringify({
    file_hash: ctx.fileHash,
    file_name: ctx.fileName,
    row: r.rowNumber,
    uploaded_by: ctx.uploadedBy,
    uploaded_at: ctx.now.toISOString(),
    channel: ctx.channel,
    ...(ctx.source?.notes ?? {}),
    ...(unmatchedVenue ? { venue_unmatched: true } : {}),
  });
  const rows = fields
    .filter((f): f is [string, string] => f[1] !== null && f[1] !== "")
    .map(([fieldName, value]) => ({
      id: crypto.randomUUID(),
      eventId,
      fieldName,
      value,
      year,
      sourceUrl: citationSource(ctx, r.rowNumber),
      sourceName: citationName(ctx),
      sourceType: "user_submitted" as const,
      state: "active" as const,
      notes,
      createdBy: ctx.uploadedBy,
      provenanceKind: ctx.source?.provenanceKind ?? ("promoter_portal" as const),
      createdAt: ctx.now,
    }));
  for (let i = 0; i < rows.length; i += CITATION_CHUNK) {
    await db.insert(eventDataCitations).values(rows.slice(i, i + CITATION_CHUNK));
  }
}
