/**
 * K23 (Dev-Email-2026-06-13 §B1) — `resubmit_indexnow`.
 *
 * Sanctioned way to re-ping arbitrary URLs to Bing IndexNow. Before this tool
 * the only path was `flush_pending_search_pings` (drains the internal outbox)
 * or `request_indexing` (Google-only, "do NOT bulk-submit"). Backfilling the
 * REL4 failures by hand meant reading distinct failed URLs out of
 * `indexnow_submissions`, resolving each slug → entity_id, hand-writing rows
 * into `pending_search_pings`, then flushing — ~5 D1 round-trips for what should
 * be one call (exactly the error-prone pattern slug-normalization-at-harvest
 * warns against).
 *
 * Two modes in one tool:
 *   - explicit:  pass `urls: [...]`
 *   - from-log:  omit `urls` → auto-pull distinct `status='failure'` URLs from
 *                indexnow_submissions in the last `since_hours`, optionally
 *                filtered to one `http_status` (e.g. 429).
 *
 * Submits ONE batched call through the main app's REL4-fixed
 * /api/internal/indexnow endpoint, so it inherits REL4's batching + Retry-After
 * backoff and — crucially — reports the TRUE Bing HTTP status instead of a
 * blind "ok". A throttled re-submit is reported as a failure (the URLs are not
 * marked done anywhere), so the operator can re-run once Bing's cooldown clears.
 *
 * STRICT dependency (per the brief): this rides on REL4. Built on the pre-REL4
 * flush it would inherit the silent-drop bug.
 *
 * Admin only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte } from "drizzle-orm";
import { adminActions, indexnowSubmissions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { submitIndexNowBatch } from "../pending-pings.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  DB?: D1Database;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

const SITE_PREFIX = "https://meetmeatthefair.com/";
const HARD_MAX_URLS = 10_000; // matches /api/internal/indexnow bodySchema cap

export function registerResubmitIndexNowTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "resubmit_indexnow",
    "Re-submit URLs to Bing IndexNow in one batched call. Pass explicit `urls`, OR omit `urls` to auto-pull distinct failed submissions from indexnow_submissions in the last `since_hours` (optionally filtered to one `http_status`, e.g. 429). Rides on the REL4-fixed internal endpoint: batched, honors Bing's rate-limit cooldown, and reports the TRUE Bing HTTP status — a throttled re-submit comes back as a failure (not a blind 'ok') so you can re-run after the cooldown. Use dry_run to preview the URL set. Admin only.",
    {
      urls: z
        .array(z.string().url())
        .max(HARD_MAX_URLS)
        .optional()
        .describe(
          "Explicit URLs to re-submit. When provided, the log query is skipped. Non-meetmeatthefair.com URLs are dropped (reported under skipped)."
        ),
      since_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .default(24)
        .describe(
          "From-log mode (when `urls` omitted): pull failed submissions newer than this many hours. Default 24, max 720 (30d)."
        ),
      http_status: z
        .number()
        .int()
        .optional()
        .describe(
          "From-log mode: only re-pull failures whose logged Bing HTTP status equals this (e.g. 429). Omit to pull all failures."
        ),
      max_urls: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_URLS)
        .optional()
        .default(1000)
        .describe("Safety cap on how many URLs to submit in one call. Default 1000."),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return the URL set that would be submitted; no IndexNow call, no audit row."),
    },
    async (params) => {
      const sinceHours = params.since_hours ?? 24;
      const maxUrls = Math.min(params.max_urls ?? 1000, HARD_MAX_URLS);
      const dryRun = params.dry_run ?? false;

      // 1. Resolve the candidate URL set.
      let rawUrls: string[];
      let mode: "explicit" | "from_log";
      if (params.urls && params.urls.length > 0) {
        mode = "explicit";
        rawUrls = params.urls;
      } else {
        mode = "from_log";
        const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000);
        const conds = [
          eq(indexnowSubmissions.status, "failure"),
          gte(indexnowSubmissions.timestamp, cutoff),
        ];
        if (typeof params.http_status === "number") {
          conds.push(eq(indexnowSubmissions.httpStatus, params.http_status));
        }
        const rows = await db
          .select({ urls: indexnowSubmissions.urls })
          .from(indexnowSubmissions)
          .where(and(...conds))
          .orderBy(desc(indexnowSubmissions.timestamp))
          .limit(2000); // generous row cap; URL dedupe happens below
        rawUrls = [];
        for (const r of rows) {
          try {
            const parsed = JSON.parse(r.urls) as unknown;
            if (Array.isArray(parsed)) {
              for (const u of parsed) if (typeof u === "string") rawUrls.push(u);
            }
          } catch {
            /* skip unparseable row */
          }
        }
      }

      // 2. Dedupe, split valid (same-host) from skipped, cap to max_urls.
      const seen = new Set<string>();
      const submit: string[] = [];
      const skipped: string[] = [];
      let capped = false;
      for (const u of rawUrls) {
        const url = u.trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        if (!url.startsWith(SITE_PREFIX)) {
          skipped.push(url);
          continue;
        }
        if (submit.length >= maxUrls) {
          capped = true;
          continue;
        }
        submit.push(url);
      }

      const base = {
        mode,
        since_hours: mode === "from_log" ? sinceHours : undefined,
        http_status_filter: params.http_status,
        candidate_count: seen.size,
        submit_count: submit.length,
        skipped_count: skipped.length,
        skipped_sample: skipped.slice(0, 5),
        capped, // true if more eligible URLs existed than max_urls — re-run to drain the rest
      };

      if (submit.length === 0) {
        return {
          content: [
            jsonContent({ ...base, dry_run: dryRun, message: "No eligible URLs to submit." }),
          ],
        };
      }

      // 3. dry_run: show what would go, no network, no audit.
      if (dryRun) {
        return {
          content: [jsonContent({ ...base, dry_run: true, urls_preview: submit.slice(0, 50) })],
        };
      }

      if (!env) {
        return {
          content: [jsonContent({ ...base, error: "env_unavailable" })],
          isError: true,
        };
      }

      // 4. One batched submit through the REL4-fixed endpoint.
      const result = await submitIndexNowBatch(env, submit, "resubmit-indexnow");
      const bingStatus = result.body?.indexnow_http_status ?? (result.ok ? 200 : result.status);

      // 5. Audit (only on a real attempt).
      try {
        await db.insert(adminActions).values({
          action: "indexnow.resubmit",
          actorUserId: auth.userId,
          targetType: "system",
          targetId: crypto.randomUUID(),
          payloadJson: JSON.stringify({
            mode,
            submit_count: submit.length,
            ok: result.ok,
            bing_http_status: bingStatus,
            http_status_filter: params.http_status,
            since_hours: mode === "from_log" ? sinceHours : undefined,
          }),
          createdAt: new Date(),
        });
      } catch {
        /* audit is non-critical */
      }

      return {
        content: [
          jsonContent({
            ...base,
            ok: result.ok,
            // The TRUE Bing outcome (REL4) — not a blind "ok".
            bing_http_status: bingStatus,
            attempted: result.body?.attempted ?? submit.length,
            succeeded: result.body?.succeeded,
            failed: result.body?.failed,
            error: result.ok ? undefined : (result.body?.error ?? result.error),
            note: result.ok
              ? undefined
              : "Submission failed (likely a Bing rate-limit cooldown). URLs are NOT marked done — re-run after the cooldown clears.",
          }),
        ],
        isError: !result.ok ? true : undefined,
      };
    }
  );
}
