export function formatDateForDisplay(dateStr: string | null): string {
  if (!dateStr) return "TBD";
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return dateStr;
  }
}

export function formatTimeForDisplay(timeStr: string | null): string | null {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return timeStr;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = hours >= 12 ? "pm" : "am";
  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;
  return minutes > 0 ? `${hours}:${match[2]}${ampm}` : `${hours}${ampm}`;
}

export function isValidUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * OPE-297 rework — build the /api/admin/import-url/extract request body.
 *
 * The wizard sent `url: state.url` unconditionally. On the image/paste lane the
 * operator never types a URL, so `state.url` is its initial `""` — and the
 * endpoint's `z.string().url().optional()` rejects an empty string, because
 * `.optional()` admits `undefined`, not `""`. Zod's message for that is
 * literally "Invalid URL".
 *
 * That single mismatch produced BOTH defects John reported: the red "Invalid
 * URL" banner, and the empty Review form — because a 400 means extraction never
 * ran at all, so there were no fields to show. The OCR text was fine; nothing
 * ever looked at it.
 *
 * An absent URL is `undefined`, not `""`. Whitespace-only is also absent.
 */
export function buildExtractPayload(
  content: string,
  url: string | null | undefined,
  metadata?: Record<string, unknown>
): { content: string; url?: string; metadata: Record<string, unknown> } {
  const trimmed = (url ?? "").trim();
  return {
    content,
    ...(trimmed ? { url: trimmed } : {}),
    metadata: metadata ?? {},
  };
}
