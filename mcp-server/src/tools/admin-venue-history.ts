/**
 * OPE-1180 — admin MCP tools for a venue's cited history.
 *
 *   add_series_venue_period   "series S was held at venue V from A to B"
 *   add_venue_name_variant    another name for the venue, time-scoped
 *   add_venue_claim_citation  a further source for an existing claim
 *   list_venue_history        everything above + the "where did it go" fan-out
 *   delete_venue_history_item remove a period, variant or citation
 *
 * Every period and name variant is written WITH its first citation, in one
 * batch — the ticket's rule is that each claim carries ≥1 source, so a claim
 * cannot exist without one, and deleting a claim's LAST citation is refused.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { CLAIM_CERTAINTIES, normalizeName, parseEdtfBounds } from "@takemetothefair/utils";
import {
  eventSeries,
  seriesVenuePeriods,
  venueClaimCitations,
  venueNameVariants,
  venues,
} from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { CLAIM_CITATION_PARAM, citationRow } from "../venues/lifecycle.js";
import { loadVenueHistory } from "../venues/history.js";

const EDTF_PARAM = z
  .string()
  .max(20)
  .optional()
  .describe('EDTF date: "1869", "1869-09", "1869~", "186X". Omit when unknown.');

const err = (error: string, message: string, extra: Record<string, unknown> = {}) => ({
  content: [jsonContent({ error, message, ...extra })],
  isError: true as const,
});

function checkEdtf(label: string, v: string | undefined): string | null {
  if (v === undefined || v.trim() === "") return null;
  return parseEdtfBounds(v)
    ? null
    : `${label} "${v}" is not a supported EDTF date (e.g. 1869, 1869-09, 1869~, 186X).`;
}

async function venueExists(db: Db, venueId: string): Promise<boolean> {
  const [v] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return !!v;
}

export function registerVenueHistoryTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "add_series_venue_period",
    "Record that a series was held at a venue from one date to another (OPE-1180). Pass series_id for a series MMATF has, or series_name for a historical series it does not (no empty series hub is created). to_edtf omitted = still held there. Requires citation. Admin only.",
    {
      venue_id: z.string(),
      series_id: z.string().optional(),
      series_name: z.string().max(200).optional(),
      from_edtf: EDTF_PARAM,
      to_edtf: EDTF_PARAM,
      certainty: z.enum(CLAIM_CERTAINTIES).optional().default("certain"),
      notes: z.string().max(1000).optional(),
      citation: CLAIM_CITATION_PARAM,
    },
    async (p) => {
      if (!p.series_id && !p.series_name?.trim()) {
        return err(
          "series_required",
          "Pass series_id, or series_name for a series MMATF does not hold."
        );
      }
      const bad = checkEdtf("from_edtf", p.from_edtf) ?? checkEdtf("to_edtf", p.to_edtf);
      if (bad) return err("invalid_edtf", bad);
      const from = p.from_edtf?.trim() ? parseEdtfBounds(p.from_edtf) : null;
      const to = p.to_edtf?.trim() ? parseEdtfBounds(p.to_edtf) : null;
      if (from && to && to.latest.getTime() < from.earliest.getTime()) {
        return err("invalid_edtf", "to_edtf is before from_edtf.");
      }
      if (!(await venueExists(db, p.venue_id))) return err("venue_not_found", "Venue not found.");
      if (p.series_id) {
        const [s] = await db
          .select({ id: eventSeries.id })
          .from(eventSeries)
          .where(eq(eventSeries.id, p.series_id))
          .limit(1);
        if (!s)
          return err(
            "series_not_found",
            "series_id does not exist; use series_name for a series MMATF does not hold."
          );
      }
      const id = crypto.randomUUID();
      await db.batch([
        db.insert(seriesVenuePeriods).values({
          id,
          seriesId: p.series_id ?? null,
          seriesName: p.series_id ? null : p.series_name!.trim(),
          venueId: p.venue_id,
          fromEdtf: p.from_edtf?.trim() || null,
          toEdtf: p.to_edtf?.trim() || null,
          fromEarliest: from?.earliest ?? null,
          toLatest: to?.latest ?? null,
          certainty: p.certainty,
          notes: p.notes ?? null,
          createdBy: auth.userId ?? null,
          createdAt: new Date(),
        }),
        db
          .insert(venueClaimCitations)
          .values(citationRow({ seriesVenuePeriodId: id }, "period", p.citation, auth.userId)),
      ] as unknown as Parameters<typeof db.batch>[0]);
      return { content: [jsonContent({ created: true, series_venue_period_id: id })] };
    }
  );

  server.tool(
    "add_venue_name_variant",
    "Record another name a venue was known by, optionally time-scoped (OPE-1180). Used by venue lookup and search. Requires citation. Admin only.",
    {
      venue_id: z.string(),
      name: z.string().min(1).max(200),
      from_edtf: EDTF_PARAM,
      to_edtf: EDTF_PARAM,
      certainty: z.enum(CLAIM_CERTAINTIES).optional().default("certain"),
      citation: CLAIM_CITATION_PARAM,
    },
    async (p) => {
      const bad = checkEdtf("from_edtf", p.from_edtf) ?? checkEdtf("to_edtf", p.to_edtf);
      if (bad) return err("invalid_edtf", bad);
      if (!(await venueExists(db, p.venue_id))) return err("venue_not_found", "Venue not found.");
      const normalized = normalizeName(p.name.trim());
      const [dup] = await db
        .select({ id: venueNameVariants.id })
        .from(venueNameVariants)
        .where(
          and(
            eq(venueNameVariants.venueId, p.venue_id),
            eq(venueNameVariants.normalizedName, normalized)
          )
        )
        .limit(1);
      if (dup) {
        return err(
          "variant_exists",
          "This venue already has that name variant; add a further source with add_venue_claim_citation.",
          {
            venue_name_variant_id: dup.id,
          }
        );
      }
      const id = crypto.randomUUID();
      await db.batch([
        db.insert(venueNameVariants).values({
          id,
          venueId: p.venue_id,
          name: p.name.trim(),
          normalizedName: normalized,
          fromEdtf: p.from_edtf?.trim() || null,
          toEdtf: p.to_edtf?.trim() || null,
          certainty: p.certainty,
          createdBy: auth.userId ?? null,
          createdAt: new Date(),
        }),
        db
          .insert(venueClaimCitations)
          .values(citationRow({ venueNameVariantId: id }, "name", p.citation, auth.userId)),
      ] as unknown as Parameters<typeof db.batch>[0]);
      return { content: [jsonContent({ created: true, venue_name_variant_id: id })] };
    }
  );

  server.tool(
    "add_venue_claim_citation",
    "Add a further source for an existing venue claim (OPE-1180). Target exactly one: venue_id + field (use_started | use_ended | current_state | current_use), series_venue_period_id, or venue_name_variant_id. Conflicting sources may coexist — set certainty. Admin only.",
    {
      venue_id: z.string().optional(),
      field: z.enum(["use_started", "use_ended", "current_state", "current_use"]).optional(),
      series_venue_period_id: z.string().optional(),
      venue_name_variant_id: z.string().optional(),
      citation: CLAIM_CITATION_PARAM,
    },
    async (p) => {
      const targets = [p.venue_id, p.series_venue_period_id, p.venue_name_variant_id].filter(
        Boolean
      );
      if (targets.length !== 1) {
        return err(
          "one_target",
          "Pass exactly one of venue_id, series_venue_period_id, venue_name_variant_id."
        );
      }
      if (p.venue_id && !p.field) return err("field_required", "A venue citation needs field.");
      if (p.venue_id && !(await venueExists(db, p.venue_id)))
        return err("venue_not_found", "Venue not found.");
      if (p.series_venue_period_id) {
        const [r] = await db
          .select({ id: seriesVenuePeriods.id })
          .from(seriesVenuePeriods)
          .where(eq(seriesVenuePeriods.id, p.series_venue_period_id))
          .limit(1);
        if (!r) return err("not_found", "No such series_venue_period_id.");
      }
      if (p.venue_name_variant_id) {
        const [r] = await db
          .select({ id: venueNameVariants.id })
          .from(venueNameVariants)
          .where(eq(venueNameVariants.id, p.venue_name_variant_id))
          .limit(1);
        if (!r) return err("not_found", "No such venue_name_variant_id.");
      }
      const row = citationRow(
        {
          venueId: p.venue_id,
          seriesVenuePeriodId: p.series_venue_period_id,
          venueNameVariantId: p.venue_name_variant_id,
        },
        p.venue_id ? p.field! : p.series_venue_period_id ? "period" : "name",
        p.citation,
        auth.userId
      );
      const id = crypto.randomUUID();
      await db.insert(venueClaimCitations).values({ id, ...row });
      return { content: [jsonContent({ created: true, venue_claim_citation_id: id })] };
    }
  );

  server.tool(
    "list_venue_history",
    "A venue's lifecycle fields and cited history (OPE-1180): lifecycle citations, series↔venue periods, name variants, and the fan-out — for each series held here, the other venues it was held at. Admin only.",
    { venue_id: z.string() },
    async ({ venue_id }) => {
      const [v] = await db
        .select({
          id: venues.id,
          name: venues.name,
          status: venues.status,
          use_started_edtf: venues.useStartedEdtf,
          use_ended_edtf: venues.useEndedEdtf,
          current_state: venues.currentState,
          current_use: venues.currentUse,
          wikidata_qid: venues.wikidataQid,
          nrhp_ref: venues.nrhpRef,
        })
        .from(venues)
        .where(eq(venues.id, venue_id))
        .limit(1);
      if (!v) return err("venue_not_found", "Venue not found.");
      return { content: [jsonContent({ venue: v, ...(await loadVenueHistory(db, venue_id)) })] };
    }
  );

  server.tool(
    "delete_venue_history_item",
    "Delete one venue history row (OPE-1180): a series_venue_period, a venue_name_variant (their citations go with them), or a single venue_claim_citation. Deleting the LAST citation of a period or name variant is refused — delete the claim instead. Admin only.",
    {
      kind: z.enum(["series_venue_period", "venue_name_variant", "venue_claim_citation"]),
      id: z.string(),
    },
    async ({ kind, id }) => {
      if (kind === "series_venue_period") {
        const r = await db
          .delete(seriesVenuePeriods)
          .where(eq(seriesVenuePeriods.id, id))
          .returning({ id: seriesVenuePeriods.id });
        return r.length
          ? { content: [jsonContent({ deleted: true, kind, id })] }
          : err("not_found", "Nothing deleted.");
      }
      if (kind === "venue_name_variant") {
        const r = await db
          .delete(venueNameVariants)
          .where(eq(venueNameVariants.id, id))
          .returning({ id: venueNameVariants.id });
        return r.length
          ? { content: [jsonContent({ deleted: true, kind, id })] }
          : err("not_found", "Nothing deleted.");
      }
      const [c] = await db
        .select()
        .from(venueClaimCitations)
        .where(eq(venueClaimCitations.id, id))
        .limit(1);
      if (!c) return err("not_found", "Nothing deleted.");
      if (c.seriesVenuePeriodId || c.venueNameVariantId) {
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)` })
          .from(venueClaimCitations)
          .where(
            c.seriesVenuePeriodId
              ? eq(venueClaimCitations.seriesVenuePeriodId, c.seriesVenuePeriodId)
              : eq(venueClaimCitations.venueNameVariantId, c.venueNameVariantId!)
          );
        if (Number(n) <= 1) {
          return err(
            "last_citation",
            "This is the claim's only source. Delete the period or name variant itself, or add another source first."
          );
        }
      }
      await db.delete(venueClaimCitations).where(eq(venueClaimCitations.id, id));
      return { content: [jsonContent({ deleted: true, kind, id })] };
    }
  );
}
