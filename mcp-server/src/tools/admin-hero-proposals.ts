/**
 * OPE-227 increment B — review the photo flywheel's staged HERO proposals.
 *
 * `list_hero_proposals` reads them straight from `admin_actions`;
 * `resolve_hero_proposal` hands a decision to the main app, which owns the
 * upload pipeline and is the only place an approved image reaches
 * `events.image_url` (fill-empty only).
 *
 * Kept separate from `list_photo_proposals` on purpose: that tool's vocabulary
 * (vision confidence, `would_auto_write`, the PHOTO_AUTOWRITE gate, intake
 * accounting) describes photos that arrived by email. A hero proposal is an
 * organizer's own og:image the flywheel went and fetched — different evidence,
 * judged a different way.
 *
 * ⚠️ The three action names are duplicated from
 * `src/lib/photo-flywheel/hero-proposals.ts` because this Worker cannot import
 * the main app. `hero-proposal-actions-in-sync-ope227.test.ts` pins them equal.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export const HERO_PROPOSED_ACTION = "event.hero_proposed";
export const HERO_ATTEMPT_ACTION = "event.hero_propose_attempt";
export const HERO_RESOLVED_ACTION = "event.hero_resolved";

interface HeroPayload {
  event_id?: string;
  event_slug?: string;
  event_name?: string;
  photo_key?: string;
  photo_url?: string;
  candidate_url?: string;
  og_source?: string;
  source_url?: string;
  content_type?: string;
  bytes?: number;
  width?: number | null;
  height?: number | null;
  demand_impressions?: number;
  /** OPE-746 — set when this proposal would replace a hero the rot sweep found dead. */
  replaces_dead_url?: string | null;
  dead_status_code?: number | null;
}

function parse<T>(json: string | null): T | null {
  try {
    return JSON.parse(json ?? "{}") as T;
  } catch {
    return null;
  }
}

export function registerHeroProposalTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: MainAppEnv
): void {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_hero_proposals",
    "OPE-227 — hero images the photo flywheel STAGED for imageless event pages (or, OPE-746, pages whose hero the rot sweep found dead — replaces_dead_url is then set): the organizer's own og:image, re-hosted on our R2, awaiting a human decision. Each row shows the event, its search demand, the staged image (photo_url — open it to judge), where it came from, and its dimensions. Nothing here is live on the site until resolve_hero_proposal approves it. Admin only. Read-only.",
    {
      status: z
        .enum(["pending", "resolved", "all"])
        .optional()
        .default("pending")
        .describe("pending (default) = awaiting a decision; resolved = decided; all = both."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(25)
        .describe("Max rows (default 25)."),
    },
    async (params) => {
      const proposals = await db
        .select({
          id: adminActions.id,
          payload: adminActions.payloadJson,
          createdAt: adminActions.createdAt,
        })
        .from(adminActions)
        .where(eq(adminActions.action, HERO_PROPOSED_ACTION))
        .orderBy(desc(adminActions.createdAt))
        .limit(params.status === "pending" ? 500 : params.limit);

      // Resolutions for exactly these proposals, fetched in chunks well under
      // D1's 100-bound-parameter cap (the list above can be up to 500 ids).
      const resolutions = new Map<
        string,
        { resolution?: string; note?: string | null; decided_at: Date }
      >();
      const ids = proposals.map((p) => p.id);
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const rows = await db
          .select({
            targetId: adminActions.targetId,
            payload: adminActions.payloadJson,
            createdAt: adminActions.createdAt,
          })
          .from(adminActions)
          .where(
            and(
              eq(adminActions.action, HERO_RESOLVED_ACTION),
              eq(adminActions.targetType, "admin_action"),
              inArray(adminActions.targetId, chunk)
            )
          );
        for (const r of rows) {
          const p = parse<{ resolution?: string; note?: string | null }>(r.payload) ?? {};
          resolutions.set(r.targetId, { ...p, decided_at: r.createdAt });
        }
      }

      const shaped = proposals
        .map((row) => {
          const p = parse<HeroPayload>(row.payload) ?? {};
          const res = resolutions.get(row.id);
          return {
            proposal_id: row.id,
            staged_at: row.createdAt,
            status: res ? (res.resolution ?? "resolved") : "pending",
            decided_at: res?.decided_at ?? null,
            event_id: p.event_id ?? null,
            event_name: p.event_name ?? null,
            event_url: p.event_slug ? `https://meetmeatthefair.com/events/${p.event_slug}` : null,
            demand_impressions: p.demand_impressions ?? null,
            photo_url: p.photo_url ?? null,
            dimensions: p.width && p.height ? `${p.width}x${p.height}` : null,
            bytes: p.bytes ?? null,
            candidate_url: p.candidate_url ?? null,
            source_url: p.source_url ?? null,
            og_source: p.og_source ?? null,
            // OPE-746 — non-null means approving REPLACES this dead image
            // (after a fresh probe) rather than filling an empty slot.
            replaces_dead_url: p.replaces_dead_url ?? null,
            dead_status_code: p.dead_status_code ?? null,
          };
        })
        .filter((x) =>
          params.status === "all"
            ? true
            : params.status === "pending"
              ? x.status === "pending"
              : x.status !== "pending"
        )
        .slice(0, params.limit);

      const pendingTotal = proposals.filter((p) => !resolutions.has(p.id)).length;
      return {
        content: [
          jsonContent({
            proposals: shaped,
            count: shaped.length,
            pending_total: pendingTotal,
            note:
              proposals.length === 0
                ? "No hero proposals staged yet. The flywheel stages them via POST /api/admin/photo-flywheel/hero-proposals."
                : undefined,
          }),
        ],
      };
    }
  );

  server.tool(
    "resolve_hero_proposal",
    "OPE-227 — approve or reject a staged hero proposal (see list_hero_proposals). APPROVE re-runs the staged image through the upload pipeline (EXIF strip, WebP) and sets the event's image_url — ONLY if the event still has no image; if one appeared meanwhile it refuses (409) and you should reject instead. REJECT records the decision and changes nothing public. A proposal can be resolved once. Admin only.",
    {
      proposal_id: z.string().min(1).max(64).describe("proposal_id from list_hero_proposals."),
      decision: z.enum(["approve", "reject"]),
      note: z.string().max(500).optional().describe("Why — recorded with the decision."),
    },
    async (params) => {
      let res: Response;
      try {
        res = await mainAppFetch(
          env ?? {},
          "/api/admin/photo-flywheel/hero-proposals/resolve",
          "fetch",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          }
        );
      } catch (e) {
        return {
          content: [
            jsonContent({
              ok: false,
              error: `Could not reach the main app: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ],
          isError: true,
        };
      }
      const body = (await res
        .json()
        .catch(() => ({ ok: false, error: `HTTP ${res.status}, non-JSON` }))) as Record<
        string,
        unknown
      >;
      return {
        content: [jsonContent({ http_status: res.status, ...body })],
        ...(res.ok ? {} : { isError: true }),
      };
    }
  );
}
