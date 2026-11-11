/**
 * OPE-1630 — the feed review step, over MCP. Thin X-Internal-Key wrappers over
 * the main app's /api/admin/feed-items routes, which own the logic
 * (`src/lib/feed-review/review.ts`) — approve runs the same event writer the
 * spreadsheet import and the promoter API use, and that writer lives in the app.
 *
 *   list_feed_items  — read-only: the review queue, with the closest existing event.
 *   review_feed_item — one action on one item: approve / approve_as_occurrence /
 *                      link / reject. Audit-logged. Sends nothing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import type { AuthContext } from "../auth.js";

const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function registerFeedReviewTools(server: McpServer, auth: AuthContext, env?: MainAppEnv) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_feed_items",
    "OPE-1630 — the organizer-feed review queue. Items a scheduled feed read found on a promoter's own calendar: title, local start, URL, the feed's venue text, the inclusion verdict and its reason, review_state, the linked event (if any), the reviewer's note, and — for items not yet linked — closest_event, the listing dedup thinks it is (link to that instead of approving). Filters: feed_id, promoter_id, review_state (default awaiting_review; 'all' for every state: none / awaiting_review / linked / dropped / rejected). Items no longer on the feed are left out. Pages of up to 50 (offset). Read-only.",
    {
      feed_id: z.string().min(1).optional(),
      promoter_id: z.string().min(1).optional(),
      review_state: z
        .enum(["all", "none", "awaiting_review", "linked", "dropped", "rejected"])
        .default("awaiting_review"),
      limit: z.number().int().min(1).max(50).default(25),
      offset: z.number().int().min(0).default(0),
    },
    async (p) => {
      if (!env?.INTERNAL_API_KEY && !env?.MAIN_APP)
        return err("unconfigured: no MAIN_APP binding or INTERNAL_API_KEY");
      const q = new URLSearchParams({
        review_state: p.review_state,
        limit: String(p.limit),
        offset: String(p.offset),
      });
      if (p.feed_id) q.set("feed_id", p.feed_id);
      if (p.promoter_id) q.set("promoter_id", p.promoter_id);
      const res = await mainAppFetch(env, `/api/admin/feed-items?${q}`, "fetch");
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) return err(`list failed: ${body?.error ?? `HTTP ${res.status}`}`);
      return { content: [jsonContent(body)] };
    }
  );

  server.tool(
    "review_feed_item",
    "OPE-1630 — act on ONE organizer-feed item (ids from list_feed_items). Admin only; audit-logged (admin_actions feed_item.<action>); sends no email. Actions: " +
      "'approve' — create the listing from the item through the same writer as the spreadsheet import (dedup, slug, venue matching, category allow-list, series attach by name), every value cited to the item URL (provenance feed); status by the existing approval gate (APPROVED when it has a venue, else TENTATIVE); the item is then linked so later reads keep it current. REFUSED with venue_candidates when the feed's venue matches no venue we have (never guessed), and with a suggest:{action:'link'} when dedup finds the event already listed. " +
      "'approve_as_occurrence' — the same, attached to series_id instead of resolving a series by name (for an organizer that alternates a show's name). " +
      "'link' — event_id: the item IS this existing listing; links it, changes no event field. " +
      "'reject' — note is REQUIRED (the reason, e.g. 'private event'); remembered by the item's external id: later reads keep it rejected, never re-queue, link or ask about it. A rejected item cannot be approved (reverse it deliberately, not by accident).",
    {
      feed_item_id: z.string().min(1),
      action: z.enum(["approve", "approve_as_occurrence", "link", "reject"]),
      event_id: z.string().min(1).optional().describe("link: the existing event."),
      series_id: z.string().min(1).optional().describe("approve_as_occurrence: the series."),
      note: z
        .string()
        .max(1000)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Reviewer's note; REQUIRED for reject (the reason)."),
    },
    async (p) => {
      if (!env?.INTERNAL_API_KEY && !env?.MAIN_APP)
        return err("unconfigured: no MAIN_APP binding or INTERNAL_API_KEY");
      const res = await mainAppFetch(
        env,
        `/api/admin/feed-items/${encodeURIComponent(p.feed_item_id)}/review`,
        "fetch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: p.action,
            event_id: p.event_id,
            series_id: p.series_id,
            note: p.note,
            actorUserId: auth.userId ?? null,
          }),
        }
      );
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return err(`review failed: HTTP ${res.status}`);
      // A refusal (duplicate, venue_unmatched, …) is an answer, not a transport error:
      // return it whole so the caller sees the suggestion or the candidates.
      return body.ok ? { content: [jsonContent(body)] } : { ...err(JSON.stringify(body, null, 2)) };
    }
  );
}
