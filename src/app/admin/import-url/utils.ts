export function formatDateForDisplay(dateStr: string | null): string {
  if (!dateStr) return "TBD";
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
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
