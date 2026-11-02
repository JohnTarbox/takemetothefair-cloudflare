/**
 * OPE-1562 — `create_series`: give a standalone recurring event (or several
 * editions of one fair) its event series, so `create_occurrence` can stage a
 * dates-TBD future edition under it.
 *
 * The gap it closes: `create_occurrence` needs a `series_id`; the only tool that
 * MINTS series, `backfill_event_series`, is a global clustering scan whose
 * commit is gated (EH3_P1_BACKFILL_ENABLED → 423) and which never forms a
 * single-occurrence series. So a fair with one edition and no parent could not
 * be pre-staged for next year (the Connors Waterville fairs, 2026-11-02).
 *
 * ── One resolver, not a second one ──────────────────────────────────────
 *
 * Every ingest path already parents a new event through
 * `attachEventToSeries` (@takemetothefair/event-series, OPE-472): key =
 * normalized name + venue, MATCH an existing series at that venue, else MINT
 * one (slug venue-suffixed on clash). This tool calls exactly that, per named
 * event. So its dedup is the ingest dedup — it joins an existing series rather
 * than minting a duplicate — and it inherits the resolver's refusals: no venue,
 * no usable name. A second implementation is how a fix lands in one of two
 * parallel paths.
 *
 * ── What it refuses (writes nothing) ─────────────────────────────────────
 *
 *   - an id that is not an event, or is a merge tombstone, or REJECTED
 *   - an event with no venue (the resolver would put every "Holiday Craft
 *     Fair" in New England under one parent — the reason it skips)
 *   - several events that would NOT land in one series (different venues or
 *     different names): the resolver deliberately keeps those apart, so asking
 *     for "one series" from them is a contradiction to surface, not resolve.
 *
 * An event that ALREADY has a series is reported and left alone — the attach is
 * `series_id IS NULL`-guarded, so this can never re-parent anything.
 *
 * DRY RUN BY DEFAULT: returns the plan (would match series X / would create a
 * series named Y). `dry_run:false` attaches, writes one admin_actions row
 * (`series.promote`), and reads every event's series_id back.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq, inArray } from "drizzle-orm";
import {
  attachEventToSeries,
  seriesNameKey,
  stripNameEditionSuffix,
} from "@takemetothefair/event-series";
import { adminActions, events, eventSeries } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { jsonContent } from "../helpers.js";

export interface PromoteCandidate {
  id: string;
  name: string;
  slug: string;
  status: string;
  venueId: string | null;
  promoterId: string | null;
  seriesId: string | null;
  mergedInto: string | null;
}

export interface PromotePlan {
  /** Events that will be attached (series_id currently NULL). */
  toAttach: PromoteCandidate[];
  /** Events already in a series — reported, never touched. */
  alreadyInSeries: Array<{ id: string; slug: string; seriesId: string }>;
  /** Reasons nothing may be written. Empty = applicable. */
  problems: string[];
  /** Ids examined — the landmark beside an empty problem list. */
  examined: number;
}

/** Pure planner — unit-tested; the tool loads the rows and applies the plan. */
export function planPromoteToSeries(
  requestedIds: readonly string[],
  rows: readonly PromoteCandidate[]
): PromotePlan {
  const plan: PromotePlan = { toAttach: [], alreadyInSeries: [], problems: [], examined: 0 };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groupKeys = new Set<string>();

  for (const id of new Set(requestedIds)) {
    plan.examined++;
    const e = byId.get(id);
    if (!e) {
      plan.problems.push(`${id} is not an event`);
      continue;
    }
    if (e.mergedInto) {
      plan.problems.push(`${e.slug} is a merge tombstone (merged into ${e.mergedInto})`);
      continue;
    }
    if (e.status === "REJECTED") {
      plan.problems.push(`${e.slug} is REJECTED`);
      continue;
    }
    if (e.seriesId) {
      plan.alreadyInSeries.push({ id: e.id, slug: e.slug, seriesId: e.seriesId });
      continue;
    }
    if (!e.venueId) {
      plan.problems.push(
        `${e.slug} has no venue — set one with update_event first (a series is keyed on name + venue)`
      );
      continue;
    }
    const key = seriesNameKey(e.name);
    if (!key) {
      plan.problems.push(`${e.slug} has no usable name to key a series on`);
      continue;
    }
    groupKeys.add(`${key}\u0000${e.venueId}`);
    plan.toAttach.push(e);
  }

  if (groupKeys.size > 1) {
    plan.problems.push(
      `these events would form ${groupKeys.size} separate series (different names or venues) — call create_series once per fair`
    );
  }
  if (plan.toAttach.length === 0 && plan.problems.length === 0) {
    plan.problems.push("nothing to do: every named event already belongs to a series");
  }
  return plan;
}

export function registerCreateSeriesTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "create_series",
    [
      "Give a standalone recurring event its event series (or put several editions of",
      "ONE fair under one series), so create_occurrence can then stage a dates-TBD",
      "future edition. Uses the same name+venue resolver every ingest path uses: it",
      "JOINS an existing series for that fair at that venue if one exists, otherwise",
      "creates one (works for a single event — no 2-occurrence minimum, no env flag).",
      "Refuses, writing nothing: unknown ids, merge tombstones, REJECTED events,",
      "events with no venue, or events that would form different series (different",
      "names or venues — call once per fair). Events already in a series are reported",
      "and left alone; it never re-parents. DRY RUN by default — returns the plan;",
      "pass dry_run:false to apply. Audited in admin_actions (series.promote).",
    ].join(" "),
    {
      event_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("Event ids — one fair: a single standalone event, or its several editions."),
      dry_run: z.boolean().optional().describe("Default true: return the plan only."),
      reason: z.string().max(500).optional().describe("Why — recorded in the audit row."),
    },
    async (params) => {
      const dryRun = params.dry_run !== false;
      const rows = await db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          status: events.status,
          venueId: events.venueId,
          promoterId: events.promoterId,
          seriesId: events.seriesId,
          mergedInto: events.mergedInto,
        })
        .from(events)
        .where(inArray(events.id, params.event_ids));
      const plan = planPromoteToSeries(params.event_ids, rows as PromoteCandidate[]);

      const base = {
        examined: plan.examined,
        already_in_series: plan.alreadyInSeries,
        problems: plan.problems,
      };
      if (plan.problems.length > 0) {
        return { content: [jsonContent({ applied: false, dry_run: dryRun, ...base })] };
      }

      // Preview: does a series for this fair already exist at this venue?
      const lead = plan.toAttach[0];
      const key = seriesNameKey(lead.name);
      const atVenue = await db
        .select({ id: eventSeries.id, name: eventSeries.name, slug: eventSeries.canonicalSlug })
        .from(eventSeries)
        .where(eq(eventSeries.venueId, lead.venueId as string));
      const existing = atVenue.find((s) => seriesNameKey(s.name) === key) ?? null;
      const preview = existing
        ? { outcome: "would_match", series_id: existing.id, canonical_slug: existing.slug }
        : { outcome: "would_create", series_name: stripNameEditionSuffix(lead.name) };

      if (dryRun) {
        return {
          content: [
            jsonContent({
              applied: false,
              dry_run: true,
              ...preview,
              to_attach: plan.toAttach.map((e) => ({ id: e.id, slug: e.slug })),
              ...base,
            }),
          ],
        };
      }

      const results: Array<{ id: string; outcome: string; reason?: string }> = [];
      for (const e of plan.toAttach) {
        const r = await attachEventToSeries(db, e.id, {
          name: e.name,
          venueId: e.venueId as string,
          promoterId: e.promoterId ?? null,
        });
        results.push({ id: e.id, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
      }

      // Read back the stored fact rather than trusting the resolver's return.
      const after = await db
        .select({ id: events.id, seriesId: events.seriesId })
        .from(events)
        .where(
          inArray(
            events.id,
            plan.toAttach.map((e) => e.id)
          )
        );
      const seriesIds = [...new Set(after.map((a) => a.seriesId).filter(Boolean))] as string[];
      const unparented = after.filter((a) => !a.seriesId).map((a) => a.id);
      const ok = unparented.length === 0 && seriesIds.length === 1;

      const [series] = seriesIds.length
        ? await db
            .select({ id: eventSeries.id, slug: eventSeries.canonicalSlug, name: eventSeries.name })
            .from(eventSeries)
            .where(eq(eventSeries.id, seriesIds[0]))
        : [];

      await db.insert(adminActions).values({
        action: "series.promote",
        actorUserId: auth.userId ?? null,
        targetType: "event_series",
        targetId: seriesIds[0] ?? lead.id,
        payloadJson: JSON.stringify({
          event_ids: plan.toAttach.map((e) => e.id),
          results,
          series_ids_after: seriesIds,
          reason: params.reason ?? null,
        }),
        createdAt: new Date(),
      });

      return {
        content: [
          jsonContent({
            applied: ok,
            dry_run: false,
            series: series ?? null,
            results,
            ...(ok
              ? {}
              : {
                  problems: [
                    ...(unparented.length
                      ? [`still unparented after attach: ${unparented.join(", ")}`]
                      : []),
                    ...(seriesIds.length > 1
                      ? [`events landed in ${seriesIds.length} series`]
                      : []),
                  ],
                }),
            examined: plan.examined,
            already_in_series: plan.alreadyInSeries,
            next: ok
              ? `create_occurrence({ series_id: "${seriesIds[0]}", year: <YYYY> }) stages a dates-TBD edition`
              : undefined,
          }),
        ],
        ...(ok ? {} : { isError: true }),
      };
    }
  );
}
