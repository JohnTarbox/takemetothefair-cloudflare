/** Shared helpers for MCP tool implementations */

/** Decode common HTML entities in user-supplied text.
 *  Used at the MCP input boundary so dedup/storage/slug see literal characters.
 *  Mirrors src/lib/scrapers/utils.ts decodeHtmlEntities. */
export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/** Generate a URL-safe slug from text (no external dependency) */
export function createSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-") // non-alphanum → hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 100);
}

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

/** Format a Date as "Mon, Jan 15, 2026" (UTC) */
export function formatDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Format a date range as a human-readable string */
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

/** Format price range */
export function formatPrice(min?: number | null, max?: number | null): string {
  if (!min && !max) return "Free";
  if (min === max || !max) return `$${min}`;
  if (!min) return `Up to $${max}`;
  return `$${min} – $${max}`;
}

/** Strip LIKE wildcards from user input to prevent wildcard injection.
 *  Drizzle's like() doesn't support ESCAPE clauses, so we remove them. */
export function escapeLike(s: string): string {
  return s.replace(/[%_]/g, "");
}

/** Statuses visible to the public for events
 *  KEEP IN SYNC with: src/lib/event-status.ts (isPublicEventStatus / PUBLIC_EVENT_STATUSES) */
export const PUBLIC_EVENT_STATUSES = ["APPROVED", "TENTATIVE"] as const;

/** Statuses visible to the public for event vendors
 *  KEEP IN SYNC with: src/lib/vendor-status.ts (isPublicVendorStatus / PUBLIC_VENDOR_STATUSES) */
export const PUBLIC_VENDOR_STATUSES = ["APPROVED", "CONFIRMED"] as const;

/** Build a concise text content response for MCP */
export function jsonContent(data: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(data, null, 2) };
}

/** Build the canonical public URL for a content slug. Mirrors
 *  src/lib/indexnow.ts:indexNowUrlFor in the main app. */
export function publicUrlFor(kind: "events" | "venues" | "vendors" | "blog", slug: string): string {
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
 *  Requires MAIN_APP_URL and INTERNAL_API_KEY in the env. */
export async function triggerIndexNow(
  urls: string | string[],
  env: { MAIN_APP_URL?: string; INTERNAL_API_KEY?: string },
  source?: string
): Promise<void> {
  if (!env.MAIN_APP_URL || !env.INTERNAL_API_KEY) {
    console.warn("[MCP/IndexNow] MAIN_APP_URL or INTERNAL_API_KEY missing — skipping ping");
    return;
  }
  const list = Array.isArray(urls) ? urls : [urls];
  if (list.length === 0) return;
  try {
    const response = await fetch(`${env.MAIN_APP_URL}/api/internal/indexnow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.INTERNAL_API_KEY,
      },
      body: JSON.stringify(source ? { urls: list, source } : { urls: list }),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      console.error(`[MCP/IndexNow] ${response.status} ${body}`);
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

// ---------------------------------------------------------------------------
// Status enums & transitions — shared between admin.ts and promoter.ts.
// KEEP IN SYNC with:
//   - VALID_TRANSITIONS: src/lib/vendor-status.ts
//   - EVENT_STATUS_ENUM:  src/lib/constants.ts (EventStatus)
//   - VENDOR_STATUS_ENUM: src/lib/constants.ts (VendorStatus)
//   - PAYMENT_STATUS_ENUM: src/lib/constants.ts (PaymentStatus)
// ---------------------------------------------------------------------------
export const VALID_TRANSITIONS: Record<string, string[]> = {
  INVITED: ["INTERESTED", "APPLIED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  INTERESTED: ["APPLIED", "WITHDRAWN", "CANCELLED"],
  APPLIED: ["WAITLISTED", "APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN"],
  WAITLISTED: ["APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  APPROVED: ["CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  CONFIRMED: ["WITHDRAWN", "CANCELLED"],
  REJECTED: ["APPLIED", "INVITED"],
  WITHDRAWN: ["APPLIED", "INTERESTED"],
  CANCELLED: ["INVITED"],
};

export const EVENT_STATUS_ENUM = [
  "DRAFT",
  "PENDING",
  "TENTATIVE",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
] as const;

export const VENDOR_STATUS_ENUM = [
  "INVITED",
  "INTERESTED",
  "APPLIED",
  "WAITLISTED",
  "APPROVED",
  "CONFIRMED",
  "REJECTED",
  "WITHDRAWN",
  "CANCELLED",
] as const;

export const PAYMENT_STATUS_ENUM = [
  "NOT_REQUIRED",
  "PENDING",
  "PAID",
  "REFUNDED",
  "OVERDUE",
] as const;

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
