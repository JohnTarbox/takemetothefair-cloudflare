/**
 * OPE-1327 — `set_series_edition_mode`: flag a series multi-edition (or back to
 * annual), assigning edition keys to its existing members in the SAME batch.
 *
 * Multi-edition series (OPE-1315 option A) address each member by a stored,
 * frozen `events.edition_key` instead of its year. Flipping the flag without
 * keys would leave every member addressed by its year on a series whose year
 * URLs now 301 — so the flag and the keys move together, atomically, or not at
 * all.
 *
 *   → 'multi'   every LIVE member (not REJECTED, not a merge tombstone) gets a
 *               key: an explicit `edition_keys[event_id]`, else the key it
 *               already holds, else `YYYY-MM` of its start in the venue zone.
 *               Refused — nothing written — when a member is undated, a key is
 *               malformed, or two members would share a key (same month: pass
 *               explicit suffixed keys, e.g. 2027-05-xli).
 *   → 'annual'  the flag only. Keys stay where they are, frozen: that is what
 *               lets an already-indexed edition URL 301 to its year (the
 *               permanent rollback path, OPE-1326).
 *
 * DRY RUN BY DEFAULT. ⚠️ OPE-1327 ships this tool; it must not be called with
 * dry_run:false on any prod series until OPE-1328 (John's STOP-gate).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, eq } from "drizzle-orm";
import { deriveEditionKey, isEditionKey } from "@takemetothefair/utils";
import { adminActions, events, eventSeries } from "../schema.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { jsonContent } from "../helpers.js";

export interface EditionMember {
  id: string;
  slug: string;
  status: string;
  mergedInto: string | null;
  startDate: Date | null;
  editionKey: string | null;
}

export interface EditionModePlan {
  /** Members whose key will be written (from → to). */
  assignments: Array<{ eventId: string; slug: string; from: string | null; to: string }>;
  /** Members already holding the planned key (no write). */
  unchanged: Array<{ eventId: string; slug: string; key: string }>;
  /** Reasons the plan cannot be applied. Empty = applicable. */
  problems: string[];
  /** Live members examined — the landmark beside an empty problem list. */
  examined: number;
}

/** Pure planner — unit-tested; the tool only loads members and applies the plan. */
export function planEditionMode(
  members: readonly EditionMember[],
  mode: "annual" | "multi",
  explicitKeys: Readonly<Record<string, string>> = {}
): EditionModePlan {
  const live = members.filter((m) => m.status !== "REJECTED" && !m.mergedInto);
  const plan: EditionModePlan = {
    assignments: [],
    unchanged: [],
    problems: [],
    examined: live.length,
  };
  if (mode === "annual") return plan; // flag only; keys stay frozen for the rollback 301s

  for (const id of Object.keys(explicitKeys)) {
    if (!live.some((m) => m.id === id)) {
      plan.problems.push(`edition_keys names ${id}, which is not a live member of this series`);
    }
  }

  const holder = new Map<string, string>();
  for (const m of live) {
    const key = explicitKeys[m.id] ?? m.editionKey ?? deriveEditionKey(m.startDate);
    if (!key) {
      plan.problems.push(`${m.slug} has no start date — pass edition_keys["${m.id}"]`);
      continue;
    }
    if (!isEditionKey(key)) {
      plan.problems.push(`${m.slug}: "${key}" is not YYYY-MM or YYYY-MM-<lowercase-suffix>`);
      continue;
    }
    const other = holder.get(key);
    if (other) {
      plan.problems.push(
        `${m.slug} and ${other} would both be ${key} — pass distinct suffixed edition_keys`
      );
      continue;
    }
    holder.set(key, m.slug);
    if (m.editionKey === key) plan.unchanged.push({ eventId: m.id, slug: m.slug, key });
    else plan.assignments.push({ eventId: m.id, slug: m.slug, from: m.editionKey, to: key });
  }
  return plan;
}

export function registerSeriesEditionModeTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "set_series_edition_mode",
    [
      "Flag an event series as MULTI-EDITION (it runs more than once a year, e.g. May",
      "and October) or back to ANNUAL. Multi-edition members are addressed by an",
      "edition key (/events/<series>/2027-05) instead of the year; this assigns those",
      "keys to every live member in the same atomic batch as the flag: an explicit",
      "edition_keys[event_id], else a key the member already holds, else YYYY-MM of",
      "its start date in the venue zone. Refuses (writes nothing) on an undated",
      "member, a malformed key, or two members sharing a key — pass suffixed keys",
      "(2027-05-xli) for a same-month clash. Back to annual changes only the flag;",
      "keys stay so indexed edition URLs 301 to their year. DRY RUN by default —",
      "returns the plan; pass dry_run:false to apply. Audited in admin_actions.",
    ].join(" "),
    {
      series_id: z.string().min(1).describe("event_series id."),
      mode: z.enum(["annual", "multi"]),
      edition_keys: z
        .record(z.string(), z.string())
        .optional()
        .describe('Explicit keys by event id, e.g. { "<id>": "2027-05-xli" }.'),
      dry_run: z.boolean().optional().describe("Default true: return the plan, write nothing."),
      reason: z.string().max(500).optional().describe("Why — recorded in admin_actions."),
    },
    async (params) => {
      const [series] = await db
        .select({
          id: eventSeries.id,
          slug: eventSeries.canonicalSlug,
          editionMode: eventSeries.editionMode,
        })
        .from(eventSeries)
        .where(eq(eventSeries.id, params.series_id))
        .limit(1);
      if (!series) {
        return {
          content: [jsonContent({ applied: false, error: "series_not_found" })],
          isError: true,
        };
      }
      const members = await db
        .select({
          id: events.id,
          slug: events.slug,
          status: events.status,
          mergedInto: events.mergedInto,
          startDate: events.startDate,
          editionKey: events.editionKey,
        })
        .from(events)
        .where(eq(events.seriesId, series.id));
      const plan = planEditionMode(members, params.mode, params.edition_keys ?? {});
      const dryRun = params.dry_run !== false;
      const summary = {
        series_id: series.id,
        series_slug: series.slug,
        mode_before: series.editionMode,
        mode_after: params.mode,
        examined_live_members: plan.examined,
        assignments: plan.assignments,
        unchanged: plan.unchanged,
        problems: plan.problems,
      };
      if (plan.problems.length > 0) {
        return { content: [jsonContent({ applied: false, dry_run: dryRun, ...summary })] };
      }
      if (dryRun) {
        return { content: [jsonContent({ applied: false, dry_run: true, ...summary })] };
      }

      const now = new Date();
      // One atomic D1 batch: the flag, every key, and the audit row — a flag
      // without its keys would leave members on 301ing year URLs.
      const stmts = [
        db
          .update(eventSeries)
          .set({ editionMode: params.mode, updatedAt: now })
          .where(eq(eventSeries.id, series.id)),
        ...plan.assignments.map((a) =>
          db
            .update(events)
            .set({ editionKey: a.to, updatedAt: now })
            .where(and(eq(events.id, a.eventId), eq(events.seriesId, series.id)))
        ),
        db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "series.edition_mode_set",
          actorUserId: auth.userId ?? null,
          targetType: "event_series",
          targetId: series.id,
          payloadJson: JSON.stringify({
            mode_before: series.editionMode,
            mode_after: params.mode,
            assignments: plan.assignments,
            reason: params.reason ?? null,
          }),
          createdAt: now,
        }),
      ];
      await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
      return { content: [jsonContent({ applied: true, dry_run: false, ...summary })] };
    }
  );
}
