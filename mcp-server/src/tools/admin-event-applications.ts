/**
 * OPE-1512 — the first WRITER for `event_applications`, and the digest's read.
 *
 * OPE-709 shipped the table and made `get_event_details_admin` read it "before
 * any writer" (hazard 4); OPE-794 added capacity. Neither ever got a writer —
 * every row in prod came from the 0257/0262 backfills, so a deadline, a
 * capacity change or a "vendors wanted" call had nowhere to go.
 *
 *   upsert_event_application  — patch one route row (whole-lane or one
 *                               department). Omitted field = keep; null = clear.
 *                               Returns the row BEFORE and AFTER, so a
 *                               round-trip that drops a field is visible on the
 *                               call that dropped it (the OPE-534 lesson).
 *   list_open_vendor_calls    — events whose lane is positively OPEN and whose
 *                               closing day hasn't passed, soonest deadline
 *                               first, with categories wanted / full. The data
 *                               feed for the Monday vendor digest runbook;
 *                               rendering stays in the runbook.
 *
 * Dates go in as "YYYY-MM-DD" in the venue zone and are stored per the
 * `closes_at` contract (OPE-750): the closing day at 23:59:59 America/New_York.
 * Never inferred from the event's own dates — a NULL deadline is "not
 * published", and a guessed one costs someone their entry.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { upcomingEndPredicate } from "@takemetothefair/db-schema";
import {
  EVENT_APPLICATION_LANES,
  VENDOR_CAPACITY_STATUSES,
  type EventApplicationLane,
} from "@takemetothefair/constants";
import {
  parseDateOnly,
  parseWallClockInVenueZone,
  toIsoDateOnlyInVenueZone,
} from "@takemetothefair/datetime";
import {
  isVendorCallCurrent,
  normalizeVendorCategories,
  parseVendorCategories,
  serializeVendorCategories,
} from "@takemetothefair/utils";
import { adminActions, eventApplications, events } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";

type AppRow = typeof eventApplications.$inferSelect;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayArg = z.string().regex(ISO_DAY, "YYYY-MM-DD");

/** "YYYY-MM-DD" → that day at hh:mm:ss in the venue zone. Null on a bad date. */
function venueInstant(day: string, hhmm: string, seconds = 0): Date | null {
  // parseDateOnly rejects calendar overflow ("2026-02-30"); the wall-clock
  // parser alone would roll it into March.
  if (!parseDateOnly(day)) return null;
  const d = parseWallClockInVenueZone(day, hhmm);
  return d ? new Date(d.getTime() + seconds * 1000) : null;
}
/** The OPE-750 `closes_at` convention: the closing day, 23:59:59 ET. */
export const closingInstant = (day: string) => venueInstant(day, "23:59", 59);
/** Opening is the start of the published day, 00:00 ET. */
export const openingInstant = (day: string) => venueInstant(day, "00:00");
/** As-of dates are calendar days; anchor them at noon ET so no zone shifts the day. */
const asOfInstant = (day: string) => venueInstant(day, "12:00");

const day = (d: Date | null | undefined) => (d ? toIsoDateOnlyInVenueZone(d) : null);

/** The row as an agent sees it — the same shape in `before` and `after`. */
export function presentApplication(r: AppRow) {
  return {
    id: r.id,
    event_id: r.eventId,
    lane: r.lane,
    department: r.department,
    url: r.url,
    contact_email: r.contactEmail,
    notes: r.notes,
    opens_on: day(r.opensAt),
    closes_on: day(r.closesAt),
    capacity_status: r.capacityStatus,
    capacity_as_of: day(r.capacityAsOf),
    capacity_note: r.capacityNote,
    categories_wanted: parseVendorCategories(r.categoriesWanted),
    categories_full: parseVendorCategories(r.categoriesFull),
    categories_as_of: day(r.categoriesAsOf),
  };
}

export interface ApplicationPatchInput {
  url?: string | null;
  contact_email?: string | null;
  notes?: string | null;
  opens_on?: string | null;
  closes_on?: string | null;
  capacity_status?: (typeof VENDOR_CAPACITY_STATUSES)[number];
  capacity_as_of?: string | null;
  capacity_note?: string | null;
  categories_wanted?: string[] | null;
  categories_full?: string[] | null;
  categories_as_of?: string | null;
}

export type ApplicationPatch = Partial<
  Pick<
    AppRow,
    | "url"
    | "contactEmail"
    | "notes"
    | "opensAt"
    | "closesAt"
    | "capacityStatus"
    | "capacityAsOf"
    | "capacityNote"
    | "categoriesWanted"
    | "categoriesFull"
    | "categoriesAsOf"
  >
>;

/**
 * Pure: tool args → column patch. Only keys the caller passed appear in the
 * patch, so an omitted field can never be written (and so never clobbered).
 *
 * The two `as_of` dates follow their claim: setting a capacity status other
 * than UNKNOWN stamps `capacity_as_of` (today unless given); UNKNOWN clears it,
 * per the column contract. Setting either category list stamps
 * `categories_as_of` the same way; when both lists end up empty it clears.
 */
export function buildApplicationPatch(
  input: ApplicationPatchInput,
  existing: Pick<AppRow, "categoriesWanted" | "categoriesFull"> | null,
  now: Date
): { patch: ApplicationPatch; problems: string[] } {
  const patch: ApplicationPatch = {};
  const problems: string[] = [];

  if (input.url !== undefined) patch.url = input.url;
  if (input.contact_email !== undefined) patch.contactEmail = input.contact_email;
  if (input.notes !== undefined) patch.notes = input.notes;

  const dateField = (
    v: string | null | undefined,
    name: string,
    conv: (d: string) => Date | null
  ): Date | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const d = conv(v);
    if (!d) problems.push(`${name}: "${v}" is not a real calendar date`);
    return d;
  };
  const opensAt = dateField(input.opens_on, "opens_on", openingInstant);
  if (opensAt !== undefined) patch.opensAt = opensAt;
  const closesAt = dateField(input.closes_on, "closes_on", closingInstant);
  if (closesAt !== undefined) patch.closesAt = closesAt;

  if (input.capacity_status !== undefined) {
    patch.capacityStatus = input.capacity_status;
    if (input.capacity_status === "UNKNOWN") {
      patch.capacityAsOf = null;
    } else {
      const asOf = dateField(input.capacity_as_of, "capacity_as_of", asOfInstant);
      patch.capacityAsOf = asOf ?? now;
    }
  } else if (input.capacity_as_of !== undefined) {
    const asOf = dateField(input.capacity_as_of, "capacity_as_of", asOfInstant);
    if (asOf !== undefined) patch.capacityAsOf = asOf;
  }
  if (input.capacity_note !== undefined) patch.capacityNote = input.capacity_note;

  const list = (v: string[] | null | undefined, name: string): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    try {
      return serializeVendorCategories(normalizeVendorCategories(v));
    } catch (e) {
      problems.push(`${name}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const wanted = list(input.categories_wanted, "categories_wanted");
  const full = list(input.categories_full, "categories_full");
  if (wanted !== undefined) patch.categoriesWanted = wanted;
  if (full !== undefined) patch.categoriesFull = full;

  if (wanted !== undefined || full !== undefined) {
    const finalWanted = wanted !== undefined ? wanted : (existing?.categoriesWanted ?? null);
    const finalFull = full !== undefined ? full : (existing?.categoriesFull ?? null);
    if (!finalWanted && !finalFull) {
      patch.categoriesAsOf = null;
    } else {
      const asOf = dateField(input.categories_as_of, "categories_as_of", asOfInstant);
      patch.categoriesAsOf = asOf ?? now;
    }
  } else if (input.categories_as_of !== undefined) {
    const asOf = dateField(input.categories_as_of, "categories_as_of", asOfInstant);
    if (asOf !== undefined) patch.categoriesAsOf = asOf;
  }

  return { patch, problems };
}

const categoryList = z
  .array(z.string().max(200))
  .max(100)
  .nullable()
  .optional()
  .describe(
    'Free-text vendor categories, e.g. ["Pottery", "Woodworking"]. Same space as a vendor\'s sells_category (no controlled list yet). Trimmed, deduped case-insensitively; max 25 entries of 60 chars. [] or null clears.'
  );

export function registerEventApplicationTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "upsert_event_application",
    [
      "Create or patch one application ROUTE for an event (event_applications, OPE-709):",
      "the whole lane (department omitted) or one department of it. Omitted fields are",
      "kept; null clears. Covers the organizer's vendor call: apply URL / contact email,",
      "opening and closing day (YYYY-MM-DD, venue zone; stored as the closing day",
      "23:59:59 ET — never infer a deadline from the event's dates), capacity status",
      "(OPEN / WAITLIST / FULL / CLOSED / UNKNOWN — UNKNOWN is not open) and note, and",
      "the categories the show still WANTS and has FULL (OPE-1512). Setting a capacity",
      "or category list stamps its as_of to today unless you pass one. Booth FEE and",
      "events.application_deadline stay on update_event. Returns the row before and",
      "after. Audited in admin_actions.",
    ].join(" "),
    {
      event_id: z.string().min(1),
      lane: z
        .enum(EVENT_APPLICATION_LANES)
        .optional()
        .describe("Default commercial_vendor (booth space for a business)."),
      department: z
        .string()
        .max(120)
        .transform(decodeHtmlEntities)
        .nullable()
        .optional()
        .describe(
          'Free text as the fair prints it ("Fine Arts and Crafts"). Omit for the whole lane.'
        ),
      url: z
        .string()
        .url()
        .max(2000)
        .refine((u) => /^https?:\/\//i.test(u), "http(s) URLs only")
        .nullable()
        .optional(),
      contact_email: z.string().email().max(254).nullable().optional(),
      notes: z.string().max(1000).transform(decodeHtmlEntities).nullable().optional(),
      opens_on: dayArg.nullable().optional(),
      closes_on: dayArg.nullable().optional(),
      capacity_status: z.enum(VENDOR_CAPACITY_STATUSES).optional(),
      capacity_as_of: dayArg.nullable().optional(),
      capacity_note: z.string().max(500).transform(decodeHtmlEntities).nullable().optional(),
      categories_wanted: categoryList,
      categories_full: categoryList,
      categories_as_of: dayArg.nullable().optional(),
      reason: z.string().max(500).optional().describe("Why / source — recorded in admin_actions."),
    },
    async (params) => {
      const lane: EventApplicationLane = params.lane ?? "commercial_vendor";
      const department = params.department ?? null;

      const [event] = await db
        .select({ id: events.id, slug: events.slug, mergedInto: events.mergedInto })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (!event) {
        return {
          content: [jsonContent({ applied: false, error: "event_not_found" })],
          isError: true,
        };
      }
      if (event.mergedInto) {
        return {
          content: [
            jsonContent({
              applied: false,
              error: "event_is_merge_tombstone",
              keeper_event_id: event.mergedInto,
            }),
          ],
          isError: true,
        };
      }

      const [existing] = await db
        .select()
        .from(eventApplications)
        .where(
          and(
            eq(eventApplications.eventId, event.id),
            eq(eventApplications.lane, lane),
            department === null
              ? isNull(eventApplications.department)
              : eq(eventApplications.department, department)
          )
        )
        .limit(1);

      const now = new Date();
      const { patch, problems } = buildApplicationPatch(params, existing ?? null, now);
      if (problems.length) {
        return { content: [jsonContent({ applied: false, problems })], isError: true };
      }
      if (Object.keys(patch).length === 0) {
        return {
          content: [
            jsonContent({
              applied: false,
              error: "nothing_to_write",
              row: existing ? presentApplication(existing) : null,
            }),
          ],
          isError: true,
        };
      }

      const id = existing?.id ?? crypto.randomUUID();
      const write = existing
        ? db
            .update(eventApplications)
            .set({ ...patch, updatedAt: now })
            .where(eq(eventApplications.id, id))
        : db.insert(eventApplications).values({
            id,
            eventId: event.id,
            lane,
            department,
            ...patch,
            createdAt: now,
            updatedAt: now,
          });
      const audit = db.insert(adminActions).values({
        id: crypto.randomUUID(),
        action: "event_application.upsert",
        actorUserId: auth.userId ?? null,
        targetType: "event_application",
        targetId: id,
        payloadJson: JSON.stringify({
          event_id: event.id,
          lane,
          department,
          created: !existing,
          fields: Object.keys(patch),
          before: existing ? presentApplication(existing) : null,
          reason: params.reason ?? null,
        }),
        createdAt: now,
      });
      await db.batch([write, audit] as unknown as Parameters<typeof db.batch>[0]);

      const [after] = await db
        .select()
        .from(eventApplications)
        .where(eq(eventApplications.id, id))
        .limit(1);
      return {
        content: [
          jsonContent({
            applied: true,
            created: !existing,
            event_slug: event.slug,
            fields_written: Object.keys(patch),
            before: existing ? presentApplication(existing) : null,
            after: after ? presentApplication(after) : null,
          }),
        ],
      };
    }
  );

  server.tool(
    "list_open_vendor_calls",
    [
      "Upcoming public events (APPROVED/TENTATIVE, not merged, not ended) whose",
      "application lane is positively OPEN and whose closing day has not passed —",
      "soonest deadline first, undated deadlines last. Includes categories wanted / full",
      "and their as-of date, the apply URL, and the booth fee from the event. The data",
      "feed for the Monday vendor digest (OPE-1512); UNKNOWN capacity is never listed.",
    ].join(" "),
    {
      lane: z.enum(EVENT_APPLICATION_LANES).optional().describe("Default commercial_vendor."),
      with_categories_only: z
        .boolean()
        .optional()
        .describe("Only calls that name at least one wanted category. Default false."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    },
    async (params) => {
      const lane = params.lane ?? "commercial_vendor";
      const now = new Date();
      const rows = await db
        .select({
          app: eventApplications,
          eventId: events.id,
          name: events.name,
          slug: events.slug,
          status: events.status,
          startDate: events.startDate,
          endDate: events.endDate,
          feeMin: events.vendorFeeMinCents,
          feeMax: events.vendorFeeMaxCents,
          feeNotes: events.vendorFeeNotes,
        })
        .from(eventApplications)
        .innerJoin(events, eq(eventApplications.eventId, events.id))
        .where(
          and(
            eq(eventApplications.lane, lane),
            eq(eventApplications.capacityStatus, "OPEN"),
            inArray(events.status, ["APPROVED", "TENTATIVE"]),
            isNull(events.mergedInto),
            // OPE-1375 — the one "still upcoming" rule (COALESCE(end, start),
            // 24h grace for the noon-UTC anchor); never an inline end_date compare.
            upcomingEndPredicate(now)
          )
        )
        .orderBy(
          sql`${eventApplications.closesAt} IS NULL`,
          eventApplications.closesAt,
          events.startDate
        );

      const examined = rows.length;
      const calls = rows
        .filter((r) => isVendorCallCurrent(r.app, now))
        .map((r) => ({ r, app: presentApplication(r.app) }))
        .filter(({ app }) => !params.with_categories_only || app.categories_wanted.length > 0)
        .slice(0, params.limit ?? 50)
        .map(({ r, app }) => ({
          event: {
            id: r.eventId,
            name: r.name,
            slug: r.slug,
            url: `https://meetmeatthefair.com/events/${r.slug}`,
            status: r.status,
            start_date: day(r.startDate),
            end_date: day(r.endDate),
          },
          application: {
            id: app.id,
            department: app.department,
            url: app.url,
            contact_email: app.contact_email,
            closes_on: app.closes_on,
            capacity_as_of: app.capacity_as_of,
            capacity_note: app.capacity_note,
            categories_wanted: app.categories_wanted,
            categories_full: app.categories_full,
            categories_as_of: app.categories_as_of,
          },
          booth_fee: { min_cents: r.feeMin, max_cents: r.feeMax, notes: r.feeNotes },
        }));

      return {
        content: [
          jsonContent({
            lane,
            // Landmark beside the list: how many OPEN rows the query found before
            // the calendar-day gate, so an empty result can't be mistaken for an
            // empty table.
            open_rows_examined: examined,
            count: calls.length,
            calls,
          }),
        ],
      };
    }
  );
}
