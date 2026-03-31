/** Shared helpers for MCP tool implementations */

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
  end: Date | null | undefined,
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

/** Statuses visible to the public for events */
export const PUBLIC_EVENT_STATUSES = ["APPROVED", "TENTATIVE"] as const;

/** Statuses visible to the public for event vendors */
export const PUBLIC_VENDOR_STATUSES = ["APPROVED", "CONFIRMED"] as const;

/** Build a concise text content response for MCP */
export function jsonContent(data: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(data, null, 2) };
}
