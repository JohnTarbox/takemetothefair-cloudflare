/**
 * K2 rewire (analyst, 2026-06-04) — thin HTTP client for the main-app's
 * `/api/suggest-event/check-duplicate` endpoint.
 *
 * Why HTTP and not a port: `findDuplicate` lives in the main app at
 * `src/lib/duplicates/find-duplicate.ts` and depends on Drizzle + the
 * main-app schema imports. Promoting it to `@takemetothefair/utils` would
 * require adding `drizzle-orm` + `@takemetothefair/db-schema` deps to a
 * package that's currently pure-functions-only — same tradeoff as
 * B1's burst-watch helper. The MCP Worker calls the existing main-app
 * route with `X-Internal-Key: env.INTERNAL_API_KEY` instead. Dedup
 * runs at most once per suggest/update call (not a hot path); a
 * sub-100ms internal hop is acceptable.
 *
 * Replaces the venue-only date-overlap inline queries previously in:
 *   - mcp-server/src/tools/vendor.ts ~L835 (suggest_event)
 *   - mcp-server/src/tools/admin.ts  ~L929 (update_event)
 *
 * Behavior change vs the old inline check:
 *   OLD: venue+date-overlap only. Missed same-source_url matches,
 *        same-city+state matches when venue diverged (slug-generator
 *        divergence cohort), and similar-name+date matches.
 *   NEW: findDuplicate's 4 stages (exact_url > venue_date >
 *        city_state_date > similar_name_date) with ±7d window.
 *
 * Callers preserve their existing override flags:
 *   - suggest_event: `force_create: true` bypasses the BLOCK.
 *   - update_event:  `acknowledge_possible_duplicates: true` suppresses
 *     the WARNING (current behavior — doesn't block).
 */

import { logError } from "../logger.js";

export interface CheckDuplicateInput {
  sourceUrl?: string | null;
  name?: string | null;
  /** YYYY-MM-DD or any Date-parseable string. */
  startDate?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
}

export type MatchType = "exact_url" | "venue_date" | "city_state_date" | "similar_name_date";

export interface ExistingEventDuplicate {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  status: string;
  sourceUrl: string | null;
}

export type CheckDuplicateResult =
  | { isDuplicate: false }
  | {
      isDuplicate: true;
      matchType: MatchType;
      similarity?: number;
      existingEvent: ExistingEventDuplicate;
    };

interface DispatchEnv {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  DB?: D1Database;
}

const SOURCE = "mcp:duplicates:check-duplicate";

/**
 * POST to /api/suggest-event/check-duplicate with INTERNAL_API_KEY auth.
 *
 * Fail-soft: returns `{ isDuplicate: false }` on any HTTP/auth/parse
 * failure so dedup never blocks the suggest/update path on a
 * transient main-app outage. Errors are logged via logError for
 * observability — operator can watch error_logs for spikes in
 * `mcp:duplicates:check-duplicate`.
 */
export async function checkDuplicateViaMainApp(
  env: DispatchEnv,
  input: CheckDuplicateInput
): Promise<CheckDuplicateResult> {
  if (!env.MAIN_APP_URL || !env.INTERNAL_API_KEY) {
    await logError(env.DB ?? null, {
      level: "warn",
      source: SOURCE,
      message: "MAIN_APP_URL or INTERNAL_API_KEY missing; skipping dedup check",
    }).catch(() => {});
    return { isDuplicate: false };
  }
  try {
    const res = await fetch(`${env.MAIN_APP_URL}/api/suggest-event/check-duplicate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      await logError(env.DB ?? null, {
        source: SOURCE,
        message: `check-duplicate returned ${res.status}`,
        statusCode: res.status,
        context: { bodyExcerpt: body },
      }).catch(() => {});
      return { isDuplicate: false };
    }
    const data = (await res.json()) as unknown;
    return parseResponse(data);
  } catch (error) {
    await logError(env.DB ?? null, {
      source: SOURCE,
      message: "check-duplicate fetch threw",
      error,
    }).catch(() => {});
    return { isDuplicate: false };
  }
}

/**
 * Parse the route's JSON response into the typed CheckDuplicateResult.
 * Exported for unit testing. Treats any unexpected shape as
 * `isDuplicate: false` (fail-soft) — better to miss a dup than to
 * fabricate one on a response-shape regression.
 */
export function parseResponse(data: unknown): CheckDuplicateResult {
  if (!data || typeof data !== "object") return { isDuplicate: false };
  const obj = data as Record<string, unknown>;
  if (obj.isDuplicate !== true) return { isDuplicate: false };
  const existing = obj.existingEvent as Record<string, unknown> | undefined;
  const matchType = obj.matchType as string | undefined;
  if (!existing || !matchType) return { isDuplicate: false };
  if (
    matchType !== "exact_url" &&
    matchType !== "venue_date" &&
    matchType !== "city_state_date" &&
    matchType !== "similar_name_date"
  ) {
    return { isDuplicate: false };
  }
  // Convert ISO startDate string (route serializes Dates to strings) back to Date.
  const rawStart = existing.startDate;
  const startDate =
    typeof rawStart === "string" ? new Date(rawStart) : rawStart instanceof Date ? rawStart : null;
  const result: CheckDuplicateResult = {
    isDuplicate: true,
    matchType,
    existingEvent: {
      id: String(existing.id ?? ""),
      slug: String(existing.slug ?? ""),
      name: String(existing.name ?? ""),
      startDate: startDate && !isNaN(startDate.getTime()) ? startDate : null,
      status: String(existing.status ?? ""),
      sourceUrl: existing.sourceUrl == null ? null : String(existing.sourceUrl),
    },
  };
  const sim = obj.similarity;
  if (typeof sim === "number") result.similarity = sim;
  return result;
}
