/** Shared helpers for MCP tool implementations */

import { formatDateOnly as canonicalFormatDateOnly } from "@takemetothefair/datetime";

// Canonical decodeHtmlEntities, createSlug, dollarsToCents, formatPrice all
// live in packages/utils. Re-exported here so all existing
// `import { ... } from "../helpers.js"` call sites in MCP tools keep working.
export {
  decodeHtmlEntities,
  createSlug,
  dollarsToCents,
  formatPrice,
} from "@takemetothefair/utils";

/** Parse "City, ST" into { city, state }. Returns nulls if unparseable. */
export function parseLocation(location: string): { city: string | null; state: string | null } {
  const lastComma = location.lastIndexOf(",");
  if (lastComma === -1) return { city: location.trim() || null, state: null };
  const city = location.slice(0, lastComma).trim() || null;
  const state = location.slice(lastComma + 1).trim() || null;
  return { city, state };
}

/** Parse a JSON string array stored in SQLite, returning string[] */
export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/** Format a Date as "Mon, Jan 15, 2026" (UTC). MCP-specific contract:
 *  returns `null` (not "") for null/undefined input, because tool responses
 *  encode "missing date" semantically as null in JSON. Routes through the
 *  canonical formatter from @takemetothefair/datetime for the actual format. */
export function formatDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  return canonicalFormatDateOnly(date) || null;
}

/** Format a date range as a human-readable string. MCP-specific contract
 *  with "Ends X" / "Starts X" prefixes when only one bound is set, distinct
 *  from the canonical formatDateRange "TBD"/"start - end" semantics. */
export function formatDateRange(
  start: Date | null | undefined,
  end: Date | null | undefined
): string {
  if (!start && !end) return "TBD";
  if (!start) return `Ends ${formatDate(end)}`;
  if (!end) return `Starts ${formatDate(start)}`;
  const s = formatDate(start);
  const e = formatDate(end);
  return s === e ? s! : `${s} – ${e}`;
}

/** Strip LIKE wildcards from user input to prevent wildcard injection.
 *  Drizzle's like() doesn't support ESCAPE clauses, so we remove them. */
export function escapeLike(s: string): string {
  return s.replace(/[%_]/g, "");
}

// PUBLIC_EVENT_STATUSES and PUBLIC_VENDOR_STATUSES re-exported from
// the canonical @takemetothefair/constants package. Single source of truth.
export { PUBLIC_EVENT_STATUSES, PUBLIC_VENDOR_STATUSES } from "@takemetothefair/constants";

/** Build a concise text content response for MCP */
export function jsonContent(data: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

/** Build the canonical public URL for a content slug. Mirrors
 *  src/lib/indexnow.ts:indexNowUrlFor in the main app. */
export function publicUrlFor(
  kind: "events" | "venues" | "vendors" | "promoters" | "blog",
  slug: string
): string {
  return `https://meetmeatthefair.com/${kind}/${slug}`;
}

/** Trigger an IndexNow ping via the main app's internal endpoint. The MCP
 *  server has its own DB binding so it mutates D1 directly — this endpoint is
 *  the single hook point where the actual IndexNow API call happens.
 *
 *  Fire-and-forget: never throws to the caller. Failures are logged so they
 *  surface in `wrangler tail` but never break the MCP tool response.
 *
 *  `source` lets the caller label the lifecycle event (e.g. "event-approve",
 *  "vendor-create") so the analytics tab matches the labels emitted by the
 *  main app's API routes. Falls back to "internal-api" if omitted.
 *
 *  Transport: prefers the MAIN_APP service binding (zero-latency in-account
 *  call) when bound. Falls back to public HTTPS via MAIN_APP_URL +
 *  INTERNAL_API_KEY when not — typical in local dev where Pages service
 *  bindings aren't wired up. */
export async function triggerIndexNow(
  urls: string | string[],
  env: {
    MAIN_APP?: { fetch: typeof fetch };
    MAIN_APP_URL?: string;
    INTERNAL_API_KEY?: string;
  },
  source?: string
): Promise<void> {
  const list = Array.isArray(urls) ? urls : [urls];
  if (list.length === 0) return;

  const body = JSON.stringify(source ? { urls: list, source } : { urls: list });

  // Service-binding path (preferred). The main app trusts the binding by
  // virtue of same-account same-project — no X-Internal-Key needed for this
  // path; the internal endpoint accepts the absence of the header when called
  // via service binding because... actually it still needs the header today.
  // Keep sending it for parity until the endpoint is updated to detect the
  // binding caller via the request's `cf` properties.
  if (env.MAIN_APP) {
    try {
      const response = await env.MAIN_APP.fetch(
        // Hostname is irrelevant for service bindings, but `fetch()` requires
        // a valid URL — use the public host so the route resolves identically
        // to a public call.
        new Request("https://meetmeatthefair.com/api/internal/indexnow", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": env.INTERNAL_API_KEY ?? "",
          },
          body,
        })
      );
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200);
        console.error(`[MCP/IndexNow service-binding] ${response.status} ${text}`);
      }
      return;
    } catch (error) {
      console.error("[MCP/IndexNow service-binding] error:", error);
      // Fall through to public-fetch path on transient binding error.
    }
  }

  // Public-fetch fallback (local dev or service binding unavailable).
  if (!env.MAIN_APP_URL || !env.INTERNAL_API_KEY) {
    console.warn("[MCP/IndexNow] MAIN_APP_URL or INTERNAL_API_KEY missing — skipping ping");
    return;
  }
  try {
    const response = await fetch(`${env.MAIN_APP_URL}/api/internal/indexnow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY,
      },
      body,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      console.error(`[MCP/IndexNow] ${response.status} ${text}`);
    }
  } catch (error) {
    console.error("[MCP/IndexNow] network error:", error);
  }
}

/** Compute public start/end dates from event days, excluding vendor-only days */
export function computePublicDates(days: { date: string; vendorOnly?: boolean | null }[]): {
  publicStartDate: Date | null;
  publicEndDate: Date | null;
} {
  const publicDays = days
    .filter((d) => !d.vendorOnly)
    .map((d) => d.date)
    .sort();

  if (publicDays.length === 0) {
    return { publicStartDate: null, publicEndDate: null };
  }

  return {
    publicStartDate: new Date(publicDays[0] + "T00:00:00"),
    publicEndDate: new Date(publicDays[publicDays.length - 1] + "T00:00:00"),
  };
}

// Status enums + transition state machine — sourced from the canonical
// @takemetothefair/constants package. Aliases kept for backwards compat
// with existing imports inside mcp-server/.
export {
  VENDOR_STATUS_TRANSITIONS as VALID_TRANSITIONS,
  EVENT_STATUS_VALUES as EVENT_STATUS_ENUM,
  EVENT_VENDOR_STATUS_VALUES as VENDOR_STATUS_ENUM,
  PAYMENT_STATUS_VALUES as PAYMENT_STATUS_ENUM,
} from "@takemetothefair/constants";

// ---------------------------------------------------------------------------
// Fuzzy token-overlap scoring for event name matching
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["the", "a", "an", "of", "at", "in", "and", "for", "to"]);
const YEAR_RE = /^(19|20)\d{2}$/;
const ORDINAL_RE = /^\d+(st|nd|rd|th)$/i;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t) && !YEAR_RE.test(t) && !ORDINAL_RE.test(t));
}

/** Score how well `query` matches `target` by keyword overlap (0.0–1.0).
 *  A query token matches if it is a substring of any target token or vice-versa. */
export function fuzzyTokenScore(query: string, target: string): number {
  const qTokens = tokenize(query);
  const tTokens = tokenize(target);
  if (qTokens.length === 0) return 0;

  let matched = 0;
  for (const q of qTokens) {
    if (tTokens.some((t) => t.includes(q) || q.includes(t))) {
      matched++;
    }
  }
  return matched / qTokens.length;
}
