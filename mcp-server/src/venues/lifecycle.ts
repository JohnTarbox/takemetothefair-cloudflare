/**
 * OPE-1180 — FORMER-venue helpers for the MCP Worker: the citation argument
 * every lifecycle claim carries, the "events after the closure" blocker for a
 * status change to FORMER, and the loader the event date guard reads.
 *
 * The pure rules (EDTF bounds, lifecycle validation, the guard verdict) live in
 * `@takemetothefair/utils` (`former-venue.ts`) so the main app enforces the same
 * ones.
 */
import { z } from "zod";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { CLAIM_CERTAINTIES, validateVenueLifecycle, type GuardVenue } from "@takemetothefair/utils";
import { events, venueClaimCitations, venues } from "../schema.js";
import type { Db } from "../db.js";
import { SOURCE_TYPE_VALUES } from "../tools/admin-citations.js";

/** One source for one claim. Required wherever a lifecycle claim is written. */
export const CLAIM_CITATION_PARAM = z
  .object({
    source_url: z.string().url(),
    source_type: z.enum(SOURCE_TYPE_VALUES),
    certainty: z.enum(CLAIM_CERTAINTIES).optional().default("certain"),
    notes: z.string().max(1000).optional(),
  })
  .describe(
    "The source for this claim (OPE-1180: every use_started / use_ended, period and name variant carries ≥1). certainty: certain | less-certain | uncertain."
  );
export type ClaimCitation = z.infer<typeof CLAIM_CITATION_PARAM>;

export function citationRow(
  target: { venueId?: string; seriesVenuePeriodId?: string; venueNameVariantId?: string },
  field: string | null,
  c: ClaimCitation,
  userId: string | null | undefined
) {
  return {
    venueId: target.venueId ?? null,
    seriesVenuePeriodId: target.seriesVenuePeriodId ?? null,
    venueNameVariantId: target.venueNameVariantId ?? null,
    field,
    sourceUrl: c.source_url,
    sourceType: c.source_type,
    certainty: c.certainty ?? "certain",
    notes: c.notes ?? null,
    createdBy: userId ?? null,
    createdAt: new Date(),
  };
}

export async function insertVenueCitation(
  db: Db,
  venueId: string,
  field: string,
  c: ClaimCitation,
  userId: string | null | undefined
): Promise<void> {
  await db.insert(venueClaimCitations).values(citationRow({ venueId }, field, c, userId));
}

/**
 * Non-REJECTED events at `venueId` whose last day is after `closedEarliest`.
 * A venue cannot become FORMER while any exist — they would be public events
 * held at grounds that no longer exist. REJECTED rows (incl. merge tombstones)
 * are not public, so they do not block (OPE-1180 notes).
 */
export async function eventsAfterClosure(
  db: Db,
  venueId: string,
  closedEarliest: Date
): Promise<Array<{ id: string; slug: string; name: string; status: string; ends: string | null }>> {
  const closedSec = Math.floor(closedEarliest.getTime() / 1000);
  const rows = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      status: events.status,
      endSec: sql<number | null>`COALESCE(${events.endDate}, ${events.startDate})`,
    })
    .from(events)
    .where(
      and(
        eq(events.venueId, venueId),
        ne(events.status, "REJECTED"),
        gt(sql`COALESCE(${events.endDate}, ${events.startDate})`, closedSec)
      )
    )
    .orderBy(asc(sql`COALESCE(${events.endDate}, ${events.startDate})`))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    ends: r.endSec != null ? new Date(Number(r.endSec) * 1000).toISOString().slice(0, 10) : null,
  }));
}

/** The guard's view of a venue, or null when it does not exist. */
export async function loadGuardVenue(
  db: Db,
  venueId: string | null | undefined
): Promise<GuardVenue | null> {
  if (!venueId) return null;
  const [v] = await db
    .select({
      id: venues.id,
      name: venues.name,
      status: venues.status,
      useEndedEdtf: venues.useEndedEdtf,
      useEndedEarliest: venues.useEndedEarliest,
      useEndedLatest: venues.useEndedLatest,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return v ?? null;
}

// ── create_venue / update_venue lifecycle parameters ─────────────────────

export const VENUE_LIFECYCLE_PARAMS = {
  use_started_edtf: z
    .string()
    .max(20)
    .optional()
    .describe(
      'When the site began being used as a venue, as EDTF: "1866", "1866-09", "1866~", "186X". Requires lifecycle_citation. Empty string clears.'
    ),
  use_ended_edtf: z
    .string()
    .max(20)
    .optional()
    .describe(
      'When it stopped, as EDTF ("1881", "1881~", "188X"). Required for FORMER. Requires lifecycle_citation. Empty string clears.'
    ),
  current_state: z
    .enum(["REPURPOSED", "VACANT", "DEMOLISHED", "UNKNOWN"])
    .optional()
    .describe("What the site is now (FORMER venues)."),
  current_use: z
    .string()
    .max(300)
    .optional()
    .describe('Free text, e.g. "Montpelier Country Club golf course".'),
  wikidata_qid: z
    .string()
    .regex(/^Q\d+$/)
    .optional()
    .describe("Wikidata item id, e.g. Q12345. Allowed on any venue."),
  nrhp_ref: z
    .string()
    .max(20)
    .optional()
    .describe("National Register of Historic Places reference number. Allowed on any venue."),
  lifecycle_citation: CLAIM_CITATION_PARAM.optional(),
  coordinates_verified: z
    .boolean()
    .optional()
    .describe(
      "On a change to FORMER: true keeps the existing latitude/longitude because they mark the real site (placed by hand or geocoded from a real address). Omitted, they are CLEARED — a closed venue must never carry a city-centroid pin."
    ),
};

interface LifecycleParams {
  status?: string;
  address?: string;
  latitude?: number;
  use_started_edtf?: string;
  use_ended_edtf?: string;
  lifecycle_citation?: ClaimCitation;
  coordinates_verified?: boolean;
}

interface VenueRowForLifecycle {
  id: string;
  status: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  useStartedEdtf: string | null;
  useEndedEdtf: string | null;
}

export type LifecycleResult =
  | { ok: true; notes: string[] }
  | { ok: false; error: Record<string, unknown> };

/**
 * Validate an update_venue call's lifecycle effect against the row as it WILL
 * be, and add the derived columns to `updates`. Mutates `updates` only on
 * success.
 */
export async function applyVenueLifecycleUpdate(
  db: Db,
  venue: VenueRowForLifecycle,
  params: LifecycleParams,
  updates: Record<string, unknown>
): Promise<LifecycleResult> {
  const notes: string[] = [];
  const clear = (v: string | undefined) =>
    v === undefined ? undefined : v.trim() === "" ? null : v.trim();
  const startedIn = clear(params.use_started_edtf);
  const endedIn = clear(params.use_ended_edtf);
  if ((startedIn || endedIn) && !params.lifecycle_citation) {
    return {
      ok: false,
      error: {
        error: "lifecycle_citation_required",
        message:
          "use_started_edtf / use_ended_edtf are claims about the past; pass lifecycle_citation with the source that says so.",
      },
    };
  }

  const status = (updates.status as string | undefined) ?? venue.status;
  const started = startedIn !== undefined ? startedIn : venue.useStartedEdtf;
  const ended = endedIn !== undefined ? endedIn : venue.useEndedEdtf;

  const address = (updates.address as string | undefined) ?? venue.address;
  if (status !== "FORMER" && !address?.trim()) {
    return {
      ok: false,
      error: {
        error: "address_required",
        message: "Only a FORMER venue may have a blank address.",
      },
    };
  }

  const v = validateVenueLifecycle({ status, useStartedEdtf: started, useEndedEdtf: ended });
  if (!v.ok) return { ok: false, error: { error: "invalid_lifecycle", message: v.error } };

  if (startedIn !== undefined) updates.useStartedEdtf = startedIn;
  if (endedIn !== undefined) {
    updates.useEndedEdtf = endedIn;
    // Only when the end date moves: an unrelated edit must not add columns to
    // `updates` (update_venue hands its keys to the syndication fan-out).
    updates.useEndedEarliest = v.derived.useEndedEarliest;
    updates.useEndedLatest = v.derived.useEndedLatest;
  }

  const becomingFormer = status === "FORMER" && venue.status !== "FORMER";
  const closureMoved = status === "FORMER" && ended !== venue.useEndedEdtf;
  if ((becomingFormer || closureMoved) && v.derived.useEndedEarliest) {
    const blockers = await eventsAfterClosure(db, venue.id, v.derived.useEndedEarliest);
    if (blockers.length > 0) {
      return {
        ok: false,
        error: {
          error: "events_after_closure",
          message:
            `Refused: ${blockers.length} non-REJECTED event(s) at this venue end after the closure (${ended}). ` +
            "Move them to the venue they actually use, or reject them, before marking this venue FORMER.",
          events: blockers,
        },
      };
    }
  }

  if (
    becomingFormer &&
    venue.latitude != null &&
    params.latitude === undefined &&
    params.coordinates_verified !== true
  ) {
    updates.latitude = null;
    updates.longitude = null;
    notes.push(
      "Existing coordinates were CLEARED: a FORMER venue must not carry a pin whose provenance is unknown (it may be a city centroid). Pass coordinates_verified: true, or explicit latitude/longitude, to keep a real site pin."
    );
  }
  return { ok: true, notes };
}

/** Write one citation per lifecycle claim present in the call. */
export async function writeVenueLifecycleCitations(
  db: Db,
  venueId: string,
  params: LifecycleParams,
  userId: string | null | undefined
): Promise<void> {
  const c = params.lifecycle_citation;
  if (!c) return;
  if (params.use_started_edtf?.trim())
    await insertVenueCitation(db, venueId, "use_started", c, userId);
  if (params.use_ended_edtf?.trim()) await insertVenueCitation(db, venueId, "use_ended", c, userId);
}
