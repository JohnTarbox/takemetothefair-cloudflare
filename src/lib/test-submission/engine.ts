/**
 * OPE-1625 — the test-submission engine: one dry run of the real pipeline that
 * writes nothing.
 *
 * Input is feed items (a calendar, a TEC REST feed, schema.org Event pages),
 * form fields (the OPE-1618 template's fields), or — through the promoter API's
 * `dry_run` — a request the API's own decision code has already judged. Output
 * is one `ItemReport` per event:
 *
 *   - WHAT WE READ, field by field, each with its source;
 *   - WHAT WOULD HAPPEN: `new` (would go to review), `match` (the public URL of
 *     the listing it matches and the public fields that would change), or
 *     `skip` with the reason;
 *   - PROBLEMS: missing required fields, implausible values (an AM start whose
 *     own description says PM), past dates, an incomplete location.
 *
 * REUSE, NOT A FORK. Every judgment here is the pipeline's own code:
 *   - the readers and mappers, the OPE-1613 inclusion filter and the AM/PM
 *     self-contradiction check: @takemetothefair/utils/feeds (moved out of
 *     mcp-server/src/feeds for this; the MCP Worker re-exports them);
 *   - field validation: the OPE-1618 row parser via the API's `parseApiRow`;
 *   - dedup: `findDuplicate`, and the import's own `previewRows` /
 *     `diffAgainstEvent` when a promoter is known.
 *
 * NO WRITES. The engine only ever receives a `readOnlyDb` (read-only-db.ts):
 * its write entry points throw, so a read path that writes as a side effect
 * (the ambiguous-venue audit row in autoLinkVenue) is refused, not performed.
 * `assertReadOnly` makes handing it the real database an immediate error.
 */
import {
  DEFAULT_INCLUSION_RULES,
  decideInclusion,
  detectSelfContradictions,
  to12h,
  type FeedEvent,
} from "@takemetothefair/utils/feeds";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { diffAgainstEvent, previewRows } from "@/lib/promoter-import/run";
import {
  parseDateCell,
  parseHoursCell,
  type ImportField,
  type ImportRow,
} from "@/lib/promoter-import/rows";
import { parseApiRow } from "@/lib/promoter-api/fields";
import { STATES, isStateCode } from "@/lib/states";
import { publicChanges, publicListing } from "./public-listing";
import { assertReadOnly } from "./read-only-db";
import type {
  Counts,
  ItemReport,
  Outcome,
  Problem,
  ReadField,
  SkipReason,
  SourceLabel,
} from "./types";

type Db = ReturnType<typeof getCloudflareDb>;
export type Cells = Partial<Record<ImportField, string>>;

export const SOURCE_FOR_KIND = {
  ical: "from your calendar feed",
  tec_rest: "from your calendar feed",
  jsonld: "from the linked page",
} as const satisfies Record<string, SourceLabel>;

// ------------------------------------------------------------ normalization

/** A feed item → the template's cells, so the import's row parser can judge it. */
export function feedToCells(ev: FeedEvent): Cells {
  const c: Cells = {};
  const set = (k: ImportField, v: string | null | undefined) => {
    if (v && v.trim()) c[k] = v.trim();
  };
  set("name", ev.title);
  set("start_date", ev.startDate);
  set("end_date", ev.endDate);
  if (ev.startTime && ev.endTime) set("daily_hours", `${ev.startTime}-${ev.endTime}`);
  set("venue_name", ev.venue?.name);
  set("address", ev.venue?.address);
  set("city", ev.venue?.city);
  set("state", ev.venue?.state);
  set("zip", ev.venue?.zip);
  set("description", ev.description);
  if (ev.categories.length) set("categories", ev.categories.join("; "));
  set("admission", ev.cost);
  set("event_url", ev.url);
  set("image_url", ev.imageUrl);
  return c;
}

/** Form cells → the feed shape, so the inclusion filter and the AM/PM check can judge them. */
export function cellsToFeedEvent(cells: Cells, externalId: string | null): FeedEvent {
  const hours = cells.daily_hours ? parseHoursCell(cells.daily_hours) : null;
  const start = cells.start_date ? parseDateCell(cells.start_date) : null;
  const end = cells.end_date ? parseDateCell(cells.end_date) : start;
  const venue = {
    name: cells.venue_name ?? null,
    address: cells.address ?? null,
    city: cells.city ?? null,
    state: cells.state ?? null,
    zip: cells.zip ?? null,
  };
  return {
    externalId: externalId ?? "form",
    title: cells.name ?? "",
    url: cells.event_url ?? null,
    startDate: start,
    endDate: end,
    startTime: hours?.open ?? null,
    endTime: hours?.close ?? null,
    allDay: !hours,
    timezone: "America/New_York",
    venue: Object.values(venue).some((v) => v) ? venue : null,
    organizerEmails: [],
    imageUrl: cells.image_url ?? null,
    description: cells.description ?? "",
    categories: (cells.categories ?? "")
      .split(/[;,|]/)
      .map((s) => s.trim())
      .filter(Boolean),
    cost: cells.admission ?? null,
    statusCancelled: false,
  };
}

const LABELS: Record<ReadField["field"], string> = {
  name: "Event name",
  start: "Starts",
  end: "Ends",
  daily_hours: "Daily hours",
  venue: "Venue",
  address: "Address",
  admission: "Admission",
  categories: "Categories",
  vendor_application_url: "Vendor application",
  application_deadline: "Application deadline",
  booth_fee: "Booth fee",
  image_url: "Image",
  description: "Description",
  event_url: "Event page",
};

/** What we read, field by field, each carrying its source. */
export function readFields(ev: FeedEvent, cells: Cells, source: SourceLabel): ReadField[] {
  const when = (date: string | null, time: string | null) =>
    date ? `${date}${time ? ` ${to12h(time)}` : ""}` : null;
  const place = [cells.address, cells.city, [cells.state, cells.zip].filter(Boolean).join(" ")]
    .filter((s) => s && s.trim())
    .join(", ");
  const fee =
    cells.booth_fee_min && cells.booth_fee_max && cells.booth_fee_min !== cells.booth_fee_max
      ? `$${cells.booth_fee_min}–$${cells.booth_fee_max}`
      : cells.booth_fee_min
        ? `$${cells.booth_fee_min}`
        : null;
  const values: Record<ReadField["field"], string | null> = {
    name: ev.title || null,
    start: when(ev.startDate, ev.startTime),
    end: when(ev.endDate, ev.endTime),
    daily_hours:
      ev.startTime && ev.endTime ? `${to12h(ev.startTime)} – ${to12h(ev.endTime)}` : null,
    venue: cells.venue_name ?? null,
    address: place || null,
    admission: cells.admission ?? null,
    categories: cells.categories ?? null,
    vendor_application_url: cells.vendor_application_url ?? null,
    application_deadline: cells.application_deadline ?? null,
    booth_fee: fee,
    image_url: cells.image_url ?? null,
    description: cells.description ? truncate(cells.description, 500) : null,
    event_url: cells.event_url ?? null,
  };
  return (Object.keys(LABELS) as Array<ReadField["field"]>).map((field) => ({
    field,
    label: LABELS[field],
    value: values[field],
    source: values[field] === null ? null : source,
  }));
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ problems

const REQUIRED_DATE_OR_NAME = new Set<string>(["name", "start_date", "end_date"]);
const LOCATION_FIELDS = new Set<string>(["city", "state"]);

/**
 * Problems with one event, from the row parser (OPE-1618), the feed
 * self-contradiction check (OPE-1613/1617), the date and the location.
 * `strict` — the form and the API, where the parser's errors block; a feed
 * item still goes to review with them, so there they are warnings.
 */
export function findProblems(
  ev: FeedEvent,
  row: ImportRow,
  opts: { today: string; strict: boolean }
): Problem[] {
  const out: Problem[] = [];
  const add = (p: Problem) => {
    if (!out.some((x) => x.code === p.code && x.field === p.field)) out.push(p);
  };
  const soft = opts.strict ? "error" : "warning";
  for (const e of row.fieldErrors) {
    const f = e.field;
    const missing = /is required\.$/.test(e.message);
    if (f === "state" && !missing) {
      add({ code: "outside_new_england", severity: "error", field: f, message: e.message });
    } else if (f && LOCATION_FIELDS.has(f) && missing) {
      add({
        code: "incomplete_location",
        severity: soft,
        field: f,
        message: `${e.message} We need the town and state to place the event.`,
      });
    } else if (missing) {
      add({
        code: "missing_required",
        severity: f && REQUIRED_DATE_OR_NAME.has(f) ? "error" : soft,
        field: f,
        message: e.message,
      });
    } else {
      add({
        code: "invalid_value",
        severity: f && REQUIRED_DATE_OR_NAME.has(f) ? "error" : soft,
        field: f,
        message: e.message,
      });
    }
  }
  for (const w of row.warnings)
    add({ code: "category_left_off", severity: "warning", field: "categories", message: w });
  for (const c of detectSelfContradictions(ev)) {
    const field = c.field === "start_time" ? "daily_hours" : c.field === "venue" ? "venue" : null;
    add({ code: c.kind, severity: "warning", field, message: c.feedFixNote });
  }
  const last = ev.endDate ?? ev.startDate;
  if (last && last < opts.today)
    add({
      code: "past_date",
      severity: "error",
      field: "end_date",
      message: `This event ended on ${last}, which has passed.`,
    });
  const v = ev.venue;
  if (v && v.city && !v.name && !v.address)
    add({
      code: "incomplete_location",
      severity: "warning",
      field: "venue",
      message: "There is a town but no venue name or street address.",
    });
  return out;
}

// ------------------------------------------------------------------ outcomes

/** A state we can read but do not cover (the parser only accepts the six). */
function outsideNewEngland(state: string | undefined): boolean {
  if (!state) return false;
  const s = state.trim();
  if (isStateCode(s.toUpperCase())) return false;
  return !Object.values(STATES).some((x) => x.name.toLowerCase() === s.toLowerCase());
}

const skip = (reason: SkipReason, summary: string): Outcome => ({ kind: "skip", reason, summary });

/** The OPE-1613 inclusion verdict → our skip reason. */
function skipForVerdict(reason: string): Outcome {
  if (reason.startsWith("title matches closure"))
    return skip("closure", `Skipped: this reads as a closure notice, not an event (${reason}).`);
  if (reason.startsWith("program matches"))
    return skip(
      "childrens_program",
      `Skipped: this reads as a children's or school program (${reason}). We list fairs, festivals, markets and shows.`
    );
  if (reason.startsWith("organizer")) return skip("excluded_organizer", `Skipped: ${reason}.`);
  return skip("not_an_event", `Skipped: ${reason}.`);
}

/** Cells for the diff: city/state are not compared, so a feed item missing them can still be diffed. */
function diffValue(cells: Cells, row: ImportRow): NonNullable<ImportRow["value"]> | null {
  if (row.value) return row.value;
  const filled = parseApiRow({ ...cells, city: cells.city || "-", state: "NH" }).row;
  return filled.value;
}

const NEW: Outcome = {
  kind: "new",
  summary: "New: this would go to our review queue, then be listed once approved.",
};

async function dedupOutcome(
  db: Db,
  cells: Cells,
  row: ImportRow,
  ev: FeedEvent,
  promoterId: string | null
): Promise<Outcome> {
  // With a promoter, the import's own preview decides (ownership included).
  if (promoterId && row.value) {
    const [p] = await previewRows(db, {
      promoterId,
      fileHash: "dry-run",
      rows: [row],
    });
    if (p.status === "match" && p.event) {
      const listing = await publicListing(db, p.event.id, { ownerPromoterId: promoterId });
      return {
        kind: "match",
        summary: "Matches your listing: the changes below would be sent to review.",
        listing,
        changes: publicChanges(p.changes, listing),
      };
    }
    if (p.status === "error" && p.event)
      return skip(
        "listed_by_another_organizer",
        "Skipped: this matches a listing another organizer manages. Email us if it is yours."
      );
    if (p.status === "new") return NEW;
  }
  if (!ev.startDate) return NEW;
  const dup = await findDuplicate(db, {
    sourceUrl: cells.event_url ?? null,
    name: cells.name ?? null,
    startDate: ev.startDate,
    venueName: cells.venue_name ?? null,
    venueAddress: cells.address ?? null,
    venueCity: cells.city ?? null,
    venueState: cells.state ?? null,
  });
  if (!dup.isDuplicate || !dup.identifiesSameEvent) return NEW;
  const listing = await publicListing(db, dup.existingEvent.id);
  const value = diffValue(cells, row);
  const diff =
    value && listing.showValues ? await diffAgainstEvent(db, dup.existingEvent.id, value) : {};
  return {
    kind: "match",
    summary: listing.public
      ? "Already listed: we would compare it with the listing below, not add a second one."
      : "Matches an event we have that is not public yet, so we cannot show its details.",
    listing,
    changes: publicChanges(diff, listing),
  };
}

export interface AssessOptions {
  now: Date;
  source: SourceLabel;
  /** Known only on the promoter's own channels (form, API). */
  promoterId?: string | null;
}

const todayOf = (now: Date) => now.toISOString().slice(0, 10);

/** One feed item, judged the way the feed reader would judge it. */
export async function assessFeedItem(
  db: Db,
  ev: FeedEvent,
  opts: AssessOptions
): Promise<ItemReport> {
  assertReadOnly(db);
  const today = todayOf(opts.now);
  const cells = feedToCells(ev);
  const { row } = parseApiRow(cells);
  const problems = findProblems(ev, row, { today, strict: false });
  const verdict = decideInclusion(ev, DEFAULT_INCLUSION_RULES);
  let outcome: Outcome;
  if (!verdict.included) outcome = skipForVerdict(verdict.reason);
  else if (ev.statusCancelled)
    outcome = skip("cancelled", "Skipped: the calendar marks this event cancelled.");
  else if (!ev.startDate) outcome = skip("not_an_event", "Skipped: no date we can read.");
  else if ((ev.endDate ?? ev.startDate) < today)
    outcome = skip("past_date", "Skipped: the date has passed.");
  else if (outsideNewEngland(cells.state))
    outcome = skip(
      "outside_new_england",
      `Skipped: "${cells.state}" is outside the six New England states we cover.`
    );
  else outcome = await dedupOutcome(db, cells, row, ev, opts.promoterId ?? null);
  return {
    title: ev.title,
    external_id: ev.externalId,
    read: readFields(ev, cells, opts.source),
    outcome,
    problems,
  };
}

/** Form fields (the OPE-1618 template's), judged the way the import would judge them. */
export async function assessFormFields(
  db: Db,
  cells: Cells,
  opts: AssessOptions & { externalId?: string | null }
): Promise<ItemReport> {
  assertReadOnly(db);
  const today = todayOf(opts.now);
  const ev = cellsToFeedEvent(cells, opts.externalId ?? null);
  const { row } = parseApiRow(cells);
  const problems = findProblems(ev, row, { today, strict: true });
  let outcome: Outcome;
  const last = ev.endDate ?? ev.startDate;
  if (outsideNewEngland(cells.state))
    outcome = skip(
      "outside_new_england",
      `Skipped: "${cells.state}" is outside the six New England states we cover.`
    );
  else if (!row.value)
    outcome = skip("invalid", "Not accepted as sent: fix the problems listed and try again.");
  else if (last && last < today) outcome = skip("past_date", "Skipped: the date has passed.");
  else outcome = await dedupOutcome(db, cells, row, ev, opts.promoterId ?? null);
  return {
    title: cells.name ?? "",
    external_id: opts.externalId ?? null,
    read: readFields(ev, cells, opts.source),
    outcome,
    problems,
  };
}

/**
 * The read and the problems for cells the API's own decision code judged.
 * `partial` — a PATCH or a cancel: a field the request did not send is not
 * missing, so "is required" problems are kept only for fields it did send.
 */
export function describeCells(
  cells: Cells,
  opts: { now: Date; source: SourceLabel; externalId: string | null; partial?: boolean }
): Pick<ItemReport, "title" | "external_id" | "read" | "problems"> {
  const ev = cellsToFeedEvent(cells, opts.externalId);
  const { row } = parseApiRow(cells);
  const problems = findProblems(ev, row, { today: todayOf(opts.now), strict: true }).filter(
    (p) =>
      !opts.partial ||
      !(p.code === "missing_required" || p.code === "incomplete_location") ||
      (p.field !== null && p.field in cells)
  );
  return {
    title: cells.name ?? "",
    external_id: opts.externalId,
    read: readFields(ev, cells, opts.source),
    problems,
  };
}

export function countOutcomes(items: ItemReport[]): Counts {
  return {
    read: items.length,
    would_pick_up: items.filter((i) => i.outcome.kind !== "skip").length,
    new: items.filter((i) => i.outcome.kind === "new").length,
    match: items.filter((i) => i.outcome.kind === "match").length,
    skipped: items.filter((i) => i.outcome.kind === "skip").length,
    with_problems: items.filter((i) => i.problems.length > 0).length,
  };
}
