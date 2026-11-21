/**
 * OPE-1541 — `update_series`: the MCP write path for an `event_series` row.
 *
 * Series were the only entity with a slug-history table and no tool to rename
 * them, so every rename (~146 `series_slug_history` rows by 2026-10-29) was hand
 * SQL. The redirect existed only if the writer remembered the history row: the
 * OPE-495 failure, for series. This tool makes the history row part of the
 * rename, in the same atomic batch.
 *
 * What one apply writes, all in ONE D1 batch:
 *   - the `event_series` fields, plus `updated_at`. The occurrence page's ETag
 *     takes the later of this and the member's stamp (OPE-1291), so a renamed
 *     series cannot keep serving a 304 with the old name.
 *   - on a slug change:
 *     - a `series_slug_history` row, old → new;
 *     - earlier history rows for this series are repointed at the new slug, so
 *       A→B→C is stored as A→C. The middleware already follows up to 5 hops and
 *       301s to the terminus in one hop. Repointing keeps a long rename chain
 *       under that cap.
 *     - a rename BACK to one of this series' own retired slugs deletes that
 *       history row, so the chain does not loop.
 *   - an `admin_actions` row carrying `reason`.
 *   - `pending_search_pings` rows for the hub URL. On a slug change there are
 *     two, the new URL and the old one, so the 301 is recrawled.
 *
 * A NAME change never moves the slug. A cosmetic rename must not move an
 * indexed URL by accident, so the slug changes only when `slug` is passed.
 *
 * DRY RUN BY DEFAULT. ⚠️ The first live rename of a production series is a
 * STOP-gate for John's approval (OPE-1541 notes).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq, ne } from "drizzle-orm";
import { createSlug, unsafeSlug, type Slug } from "@takemetothefair/utils";
import { invalidEventCategories } from "@takemetothefair/constants";
import {
  adminActions,
  eventSeries,
  eventSlugHistory,
  events,
  pendingSearchPings,
  seriesSlugHistory,
} from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";

export interface SeriesRow {
  id: string;
  canonicalSlug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  categories: string | null;
  tags: string | null;
}

export interface UpdateSeriesArgs {
  series_id: string;
  name?: string;
  slug?: string;
  description?: string | null;
  tags?: string[];
  categories?: string[];
  image_url?: string | null;
  reason: string;
  dry_run?: boolean;
}

/** What else already answers to a slug. Each list holds the matching ids. */
export interface SlugCollisions {
  /** Another series whose canonical slug this is. */
  series: string[];
  /** Another series that retired this slug (its old URL 301s from here). */
  otherSeriesHistory: string[];
  /** An event whose slug this is: `/events/<slug>` resolves events FIRST. */
  events: string[];
  /** An event that retired this slug (the event walk runs before the series walk). */
  eventHistory: string[];
}

type Field = "name" | "description" | "image_url" | "categories" | "tags";

export interface SeriesUpdatePlan {
  changes: Partial<Record<Field, { from: string | null; to: string | null }>>;
  slug: { from: string; to: string } | null;
  problems: string[];
}

const NO_COLLISIONS: SlugCollisions = {
  series: [],
  otherSeriesHistory: [],
  events: [],
  eventHistory: [],
};

/** Pure planner. Unit-tested; the handler only loads rows and applies the plan. */
export function planSeriesUpdate(
  current: SeriesRow,
  args: Omit<UpdateSeriesArgs, "series_id" | "reason" | "dry_run">,
  collisions: SlugCollisions = NO_COLLISIONS
): SeriesUpdatePlan {
  const plan: SeriesUpdatePlan = { changes: {}, slug: null, problems: [] };
  const diff = (field: Field, from: string | null, to: string | null | undefined) => {
    if (to !== undefined && to !== from) plan.changes[field] = { from, to };
  };

  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) plan.problems.push("name is blank");
    else diff("name", current.name, name);
  }
  diff("description", current.description, args.description);
  diff("image_url", current.imageUrl, args.image_url);
  if (args.categories !== undefined) {
    // OPE-1058: one allow-list for every categories writer. Series categories
    // seed new occurrences, so they share the event vocabulary. Refused rather
    // than dropped, as in update_event: a caller named these on purpose.
    const bad = invalidEventCategories(args.categories);
    if (bad.length > 0) {
      plan.problems.push(`categories not in EVENT_CATEGORIES: ${bad.join(", ")}`);
    } else {
      diff("categories", current.categories, JSON.stringify(args.categories));
    }
  }
  if (args.tags !== undefined) diff("tags", current.tags, JSON.stringify(args.tags));

  if (args.slug !== undefined && args.slug !== current.canonicalSlug) {
    const to = args.slug;
    if (createSlug(to) !== to) {
      plan.problems.push(
        `slug "${to}" is not canonical: lowercase letters, digits and single hyphens only (createSlug gives "${createSlug(to)}")`
      );
    }
    if (collisions.series.length > 0) {
      plan.problems.push(
        `slug "${to}" is already the canonical slug of series ${collisions.series.join(", ")}`
      );
    }
    if (collisions.otherSeriesHistory.length > 0) {
      plan.problems.push(
        `slug "${to}" is a retired slug of series ${collisions.otherSeriesHistory.join(", ")} and redirects there`
      );
    }
    if (collisions.events.length > 0) {
      plan.problems.push(
        `slug "${to}" is the slug of event ${collisions.events.join(", ")}, which /events/<slug> serves before any series hub`
      );
    }
    if (collisions.eventHistory.length > 0) {
      plan.problems.push(
        `slug "${to}" is a retired event slug (event ${collisions.eventHistory.join(", ")}), which /events/<slug> redirects before any series hub`
      );
    }
    plan.slug = { from: current.canonicalSlug, to };
  }
  return plan;
}

async function findCollisions(db: Db, seriesId: string, slug: Slug): Promise<SlugCollisions> {
  const [series, history, ev, evHistory] = await Promise.all([
    db
      .select({ id: eventSeries.id })
      .from(eventSeries)
      .where(and(eq(eventSeries.canonicalSlug, slug), ne(eventSeries.id, seriesId))),
    db
      .select({ id: seriesSlugHistory.seriesId })
      .from(seriesSlugHistory)
      .where(and(eq(seriesSlugHistory.oldSlug, slug), ne(seriesSlugHistory.seriesId, seriesId))),
    db.select({ id: events.id }).from(events).where(eq(events.slug, slug)),
    db
      .select({ id: eventSlugHistory.eventId })
      .from(eventSlugHistory)
      .where(eq(eventSlugHistory.oldSlug, slug)),
  ]);
  return {
    series: series.map((r) => r.id),
    otherSeriesHistory: history.map((r) => r.id),
    events: ev.map((r) => r.id),
    eventHistory: evHistory.map((r) => r.id),
  };
}

export type UpdateSeriesResult = Record<string, unknown> & { applied: boolean };

/** The tool body, exported for tests. Never throws on a refusal; it reports it. */
export async function handleUpdateSeries(
  db: Db,
  auth: Pick<AuthContext, "userId">,
  args: UpdateSeriesArgs
): Promise<UpdateSeriesResult> {
  const [current] = await db
    .select({
      id: eventSeries.id,
      canonicalSlug: eventSeries.canonicalSlug,
      name: eventSeries.name,
      description: eventSeries.description,
      imageUrl: eventSeries.imageUrl,
      categories: eventSeries.categories,
      tags: eventSeries.tags,
    })
    .from(eventSeries)
    .where(eq(eventSeries.id, args.series_id))
    .limit(1);
  if (!current) return { applied: false, error: "series_not_found", series_id: args.series_id };

  const newSlug =
    args.slug !== undefined && args.slug !== current.canonicalSlug ? unsafeSlug(args.slug) : null;
  const collisions = newSlug ? await findCollisions(db, current.id, newSlug) : NO_COLLISIONS;
  const plan = planSeriesUpdate(current, args, collisions);
  const dryRun = args.dry_run !== false;

  const oldSlug = unsafeSlug(current.canonicalSlug);
  // History rows this series already has pointing at the current slug. They are
  // repointed on apply, and reported so the dry run shows the chain it collapses.
  const chain = newSlug
    ? await db
        .select({ oldSlug: seriesSlugHistory.oldSlug })
        .from(seriesSlugHistory)
        .where(
          and(eq(seriesSlugHistory.seriesId, current.id), eq(seriesSlugHistory.newSlug, oldSlug))
        )
    : [];
  const reclaimed = newSlug ? chain.some((r) => r.oldSlug === newSlug) : false;

  const summary = {
    series_id: current.id,
    slug_before: current.canonicalSlug,
    slug_after: plan.slug?.to ?? current.canonicalSlug,
    changes: plan.changes,
    redirect: plan.slug
      ? {
          writes_history_row: `${plan.slug.from} → ${plan.slug.to}`,
          repoints_earlier_slugs: chain.map((r) => r.oldSlug).filter((s) => s !== newSlug),
          reclaims_own_retired_slug: reclaimed,
        }
      : null,
    problems: plan.problems,
  };

  if (plan.problems.length > 0) return { applied: false, dry_run: dryRun, ...summary };
  if (!plan.slug && Object.keys(plan.changes).length === 0) {
    return { applied: false, dry_run: dryRun, no_changes: true, ...summary };
  }
  if (dryRun) return { applied: false, dry_run: true, ...summary };

  const now = new Date();
  const set: Partial<typeof eventSeries.$inferInsert> = { updatedAt: now };
  if (plan.changes.name) set.name = plan.changes.name.to as string;
  if (plan.changes.description) set.description = plan.changes.description.to;
  if (plan.changes.image_url) set.imageUrl = plan.changes.image_url.to;
  if (plan.changes.categories) set.categories = plan.changes.categories.to;
  if (plan.changes.tags) set.tags = plan.changes.tags.to;
  if (newSlug) set.canonicalSlug = newSlug;

  const ping = (slug: Slug) =>
    db.insert(pendingSearchPings).values({
      entityType: "event", // the hub lives at /events/<slug>, the events URL kind
      entityId: current.id,
      entitySlug: slug,
      action: "update",
      queuedAt: now,
    });

  const stmts = [
    ...(newSlug
      ? [
          // Order matters. Drop a reclaimed row first, or the repoint below
          // turns it into a self-loop (A → A).
          db
            .delete(seriesSlugHistory)
            .where(
              and(
                eq(seriesSlugHistory.seriesId, current.id),
                eq(seriesSlugHistory.oldSlug, newSlug)
              )
            ),
          db
            .update(seriesSlugHistory)
            .set({ newSlug })
            .where(
              and(
                eq(seriesSlugHistory.seriesId, current.id),
                eq(seriesSlugHistory.newSlug, oldSlug)
              )
            ),
          db.insert(seriesSlugHistory).values({
            seriesId: current.id,
            oldSlug,
            newSlug,
            changedAt: now,
            changedBy: auth.userId ?? null,
          }),
        ]
      : []),
    db.update(eventSeries).set(set).where(eq(eventSeries.id, current.id)),
    db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action: "series.update",
      actorUserId: auth.userId ?? null,
      targetType: "event_series",
      targetId: current.id,
      payloadJson: JSON.stringify({
        changes: plan.changes,
        slug: plan.slug,
        reason: args.reason,
      }),
      createdAt: now,
    }),
    ping(newSlug ?? oldSlug),
    ...(newSlug ? [ping(oldSlug)] : []),
  ];
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
  return { applied: true, dry_run: false, ...summary };
}

export function registerUpdateSeriesTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "update_series",
    [
      "Edit an event series (the evergreen hub at /events/<slug>): name, slug,",
      "description, tags, categories, image_url. Use this instead of SQL. A SLUG change",
      "writes the series_slug_history row in the same atomic batch, so the old hub URL",
      "and its /<old-slug>/<year|edition> URLs 301 to the new ones. It also repoints",
      "earlier retired slugs at the new one (A→B→C becomes A→C) and queues IndexNow",
      "pings for the old and new hub. A NAME change never moves the slug: pass `slug`",
      "explicitly to move the URL. Refuses, writing nothing, when the new slug is not",
      "canonical (createSlug form) or is already used: another series' slug or retired",
      "slug, or an event's slug or retired slug, which /events/<slug> resolves first.",
      "Bumps updated_at so occurrence pages show the new name at once. DRY RUN by",
      "default: returns the plan. Pass dry_run:false to apply. Audited in admin_actions.",
    ].join(" "),
    {
      series_id: z.string().min(1).describe("event_series id."),
      name: z.string().min(1).max(200).transform(decodeHtmlEntities).optional(),
      slug: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("New canonical slug. Omit to keep the URL; a name change does not derive one."),
      description: z.string().max(10000).transform(decodeHtmlEntities).nullable().optional(),
      tags: z.array(z.string().max(100)).max(50).optional(),
      categories: z.array(z.string().max(100)).max(50).optional(),
      image_url: z.string().url().max(2000).nullable().optional(),
      reason: z.string().min(1).max(500).describe("Why. Recorded in admin_actions."),
      dry_run: z.boolean().optional().describe("Default true: return the plan, write nothing."),
    },
    async (params) => {
      const result = await handleUpdateSeries(db, auth, params);
      return {
        content: [jsonContent(result)],
        ...(result.error ? { isError: true } : {}),
      };
    }
  );
}
