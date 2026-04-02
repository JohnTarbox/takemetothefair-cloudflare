import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import slugify from "slugify";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function createSlug(text: string): string {
  return slugify(text, {
    lower: true,
    strict: true,
    trim: true,
  });
}

export function sanitizeLikeInput(input: string): string {
  return input.replace(/[%_]/g, "\\$&");
}

/**
 * Generate bounds for prefix-based slug queries using string comparison.
 * This is more reliable than LIKE patterns which can fail with "pattern too complex" errors.
 *
 * Returns [lowerBound, upperBound] for use with: slug > lowerBound AND slug < upperBound
 * Uses ASCII ordering: '-' (45) < '/' (47) < '0' (48) < 'a' (97)
 */
export function getSlugPrefixBounds(baseSlug: string): [string, string] {
  // Lower bound: baseSlug- (exclusive, so we get baseSlug-* but not baseSlug- itself)
  const lowerBound = `${baseSlug}-`;
  // Upper bound: baseSlug/ (exclusive) - '/' comes after '-' in ASCII, before '0'
  // This captures all valid slug continuations (alphanumerics and hyphens)
  const upperBound = `${baseSlug}/`;
  return [lowerBound, upperBound];
}

/**
 * Find a unique slug by checking existing slugs with the same base.
 * Appends -2, -3, etc. if the base slug is taken.
 */
export function findUniqueSlug(baseSlug: string, existingSlugs: (string | null)[]): string {
  const existing = new Set(existingSlugs);
  if (!existing.has(baseSlug)) return baseSlug;
  let i = 2;
  while (existing.has(`${baseSlug}-${i}`)) i++;
  return `${baseSlug}-${i}`;
}

export function formatDate(date: Date | string): string {
  const d = new Date(date);
  // Use UTC to avoid timezone shift (event dates are stored as midnight UTC)
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateRange(start: Date | string | null | undefined, end: Date | string | null | undefined): string {
  if (!start) {
    return "TBD";
  }

  const startDate = new Date(start);

  // Check for invalid or epoch start date
  if (isNaN(startDate.getTime()) || startDate.getTime() === 0) {
    return "TBD";
  }

  // If end date is missing, invalid, or epoch (Jan 1 1970), show start only
  const endDate = end ? new Date(end) : null;
  if (!endDate || isNaN(endDate.getTime()) || endDate.getTime() === 0) {
    return formatDate(startDate);
  }

  // Use UTC for comparison (event dates are midnight UTC)
  if (startDate.toLocaleDateString("en-US", { timeZone: "UTC" }) === endDate.toLocaleDateString("en-US", { timeZone: "UTC" })) {
    return formatDate(startDate);
  }

  return `${formatDate(startDate)} - ${formatDate(endDate)}`;
}

export function formatDiscontinuousDates(days: { date: string }[]): string {
  if (!days?.length) return "TBD";
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 1) return formatDate(new Date(sorted[0].date + "T12:00:00"));
  const first = new Date(sorted[0].date + "T12:00:00");
  const last = new Date(sorted[sorted.length - 1].date + "T12:00:00");
  return `${formatDate(first)} — ${formatDate(last)} (${sorted.length} dates)`;
}

export function formatPrice(min?: number | null, max?: number | null): string {
  if (!min && !max) return "Free";
  if (min === max || !max) return `$${min}`;
  if (!min) return `Up to $${max}`;
  return `$${min} - $${max}`;
}

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length).trim() + "...";
}

// Calendar link generation utilities
interface CalendarEventParams {
  title: string;
  description?: string;
  location?: string;
  startDate: Date | string;
  endDate: Date | string;
  url?: string;
}

function formatDateForGoogle(date: Date): string {
  return date.toISOString().replace(/-|:|\.\d{3}/g, "");
}

function formatDateForICS(date: Date): string {
  return date.toISOString().replace(/-|:|\.\d{3}/g, "").slice(0, -1);
}

export function generateGoogleCalendarUrl(params: CalendarEventParams): string {
  const { title, description, location, startDate, endDate, url } = params;
  const start = new Date(startDate);
  const end = new Date(endDate);

  const eventDescription = url
    ? `${description || ""}\n\nMore info: ${url}`.trim()
    : description || "";

  const searchParams = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${formatDateForGoogle(start)}/${formatDateForGoogle(end)}`,
    details: eventDescription,
    location: location || "",
  });

  return `https://www.google.com/calendar/render?${searchParams.toString()}`;
}

export function generateOutlookCalendarUrl(params: CalendarEventParams): string {
  const { title, description, location, startDate, endDate, url } = params;
  const start = new Date(startDate);
  const end = new Date(endDate);

  const eventDescription = url
    ? `${description || ""}\n\nMore info: ${url}`.trim()
    : description || "";

  const searchParams = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: eventDescription,
    location: location || "",
  });

  return `https://outlook.live.com/calendar/0/deeplink/compose?${searchParams.toString()}`;
}

export function generateICSContent(params: CalendarEventParams): string {
  const { title, description, location, startDate, endDate, url } = params;
  const start = new Date(startDate);
  const end = new Date(endDate);

  const eventDescription = url
    ? `${description || ""}\\n\\nMore info: ${url}`.trim()
    : description || "";

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meet Me at the Fair//EN",
    "BEGIN:VEVENT",
    `DTSTART:${formatDateForICS(start)}Z`,
    `DTEND:${formatDateForICS(end)}Z`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${eventDescription.replace(/\n/g, "\\n")}`,
    `LOCATION:${location || ""}`,
    `URL:${url || ""}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  return icsContent;
}

// Multi-day ICS generation for events with per-day schedules
interface EventDayForICS {
  date: string; // YYYY-MM-DD
  openTime: string; // HH:MM
  closeTime: string; // HH:MM
  notes?: string | null;
  closed?: boolean;
}

interface MultiDayCalendarParams {
  title: string;
  description?: string;
  location?: string;
  url?: string;
  eventDays: EventDayForICS[];
}

export function generateMultiDayICSContent(params: MultiDayCalendarParams): string {
  const { title, description, location, url, eventDays } = params;

  const openDays = eventDays.filter((d) => !d.closed);

  const eventDescription = url
    ? `${description || ""}\\n\\nMore info: ${url}`.trim()
    : description || "";

  const events = openDays.map((day) => {
    const startDateTime = new Date(`${day.date}T${day.openTime}:00`);
    const endDateTime = new Date(`${day.date}T${day.closeTime}:00`);
    const dayTitle = day.notes ? `${title} - ${day.notes}` : title;

    return [
      "BEGIN:VEVENT",
      `UID:${day.date}-${crypto.randomUUID()}@meetmeatthefair.com`,
      `DTSTART:${formatDateForICS(startDateTime)}Z`,
      `DTEND:${formatDateForICS(endDateTime)}Z`,
      `SUMMARY:${dayTitle}`,
      `DESCRIPTION:${eventDescription.replace(/\n/g, "\\n")}`,
      `LOCATION:${location || ""}`,
      `URL:${url || ""}`,
      "END:VEVENT",
    ].join("\r\n");
  });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meet Me at the Fair//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

export function generateMultiDayICSDataUrl(params: MultiDayCalendarParams): string {
  const icsContent = generateMultiDayICSContent(params);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
}

export function generateICSDataUrl(params: CalendarEventParams): string {
  const icsContent = generateICSContent(params);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
}
