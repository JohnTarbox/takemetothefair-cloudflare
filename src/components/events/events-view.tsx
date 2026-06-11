"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import { MonthCalendar, type CalendarDay } from "@johntarbox/calendar-grid";
import { useSearchParams } from "next/navigation";
import {
  LayoutGrid,
  Table,
  Calendar as CalendarIcon,
  MapPin,
  ExternalLink,
  Download,
  ChevronLeft,
  ChevronRight,
  Printer,
  Plus,
} from "lucide-react";
import { EventCard } from "./event-card";
import { EventPopover, DayEventsPopover } from "./event-popover";
import {
  SortableHeader,
  SortConfig,
  sortData,
  getNextSortDirection,
} from "@/components/ui/sortable-table";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { formatDateRange } from "@/lib/utils";
import { haversineDistance } from "@/lib/geo";
import { trackFilterApplied } from "@/lib/analytics";
import { parseJsonArray } from "@/types";
import type { events, venues, promoters } from "@/lib/db/schema";

type CalendarViewType = "day" | "week" | "month" | "year" | "schedule";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

type VendorSummary = {
  id: string;
  businessName: string;
  /** EH2.1 brand display override; null falls back to businessName. */
  displayName?: string | null;
  slug: string;
  logoUrl: string | null;
  vendorType: string | null;
};

type EventWithRelations = Event & {
  venue: Venue | null;
  promoter: Promoter | null;
  vendors?: VendorSummary[];
  eventDayDates?: string[]; // "YYYY-MM-DD" dates for discontinuous events
};

interface EventsViewProps {
  events: EventWithRelations[];
  view?: "cards" | "table" | "calendar";
  emptyMessage?: string;
  // Pagination props
  currentPage?: number;
  totalPages?: number;
  searchParams?: Record<string, string>;
  total?: number;
  myEvents?: boolean;
  /** Base path for pagination links. Defaults to "/events". */
  basePath?: string;
  /** Vendor home coordinates for distance calculation */
  vendorCoords?: { lat: number; lng: number } | null;
  /** F3 C2 — admin calendar host: enables empty-cell "+ Add event" affordances. */
  isAdmin?: boolean;
}

const SORT_OPTIONS = [
  { value: "date-asc", label: "Date (soonest)" },
  { value: "date-desc", label: "Date (latest)" },
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
  { value: "popular", label: "Most viewed" },
  { value: "nearest", label: "Nearest first" },
] as const;

function getCalendarPeriodSummary(
  events: EventWithRelations[],
  viewType: CalendarViewType,
  currentDate: Date
): { count: number; label: string } {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Helper: compare event dates (UTC midnight) against local calendar boundaries.
  // Extract UTC date from event timestamps so US timezones don't shift days backward.
  const eventDateOnly = (d: Date | string | number) => {
    const dt = new Date(d);
    return new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  };

  switch (viewType) {
    case "month": {
      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 0);
      const filtered = events.filter((e) => {
        const start = e.startDate ? eventDateOnly(e.startDate) : null;
        const end = e.endDate ? eventDateOnly(e.endDate) : start;
        if (!start) return false;
        return start <= monthEnd && (end || start) >= monthStart;
      });
      const monthName = currentDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      return { count: filtered.length, label: `in ${monthName}` };
    }
    case "week": {
      const weekStart = getWeekStart(currentDate);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const filtered = events.filter((e) => {
        const start = e.startDate ? eventDateOnly(e.startDate) : null;
        const end = e.endDate ? eventDateOnly(e.endDate) : start;
        if (!start) return false;
        return start <= weekEnd && (end || start) >= weekStart;
      });
      const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return { count: filtered.length, label: `this week (${fmt(weekStart)} - ${fmt(weekEnd)})` };
    }
    case "day": {
      const filtered = events.filter((e) => {
        const start = e.startDate ? new Date(e.startDate) : null;
        const end = e.endDate ? new Date(e.endDate) : start;
        return isDateInRange(currentDate, start, end);
      });
      const dayLabel = currentDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      return { count: filtered.length, label: `on ${dayLabel}` };
    }
    case "year": {
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31);
      const filtered = events.filter((e) => {
        const start = e.startDate ? eventDateOnly(e.startDate) : null;
        const end = e.endDate ? eventDateOnly(e.endDate) : start;
        if (!start) return false;
        return start <= yearEnd && (end || start) >= yearStart;
      });
      return { count: filtered.length, label: `in ${year}` };
    }
    case "schedule": {
      const viewStart = new Date(year, month, 1);
      const filtered = events.filter((e) => {
        const start = e.startDate ? eventDateOnly(e.startDate) : null;
        if (!start) return false;
        return start >= viewStart || (e.endDate && eventDateOnly(e.endDate) >= viewStart);
      });
      return { count: filtered.length, label: "on calendar" };
    }
  }
}

// Calendar helper functions
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

// Extract a date-only value from a UTC-midnight timestamp (event dates).
// Event dates are stored as midnight UTC; using local getDate() in US timezones
// shifts them to the previous calendar day. UTC methods avoid this.
function utcDateOnly(d: Date): Date {
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isDateInRange(date: Date, startDate: Date | null, endDate: Date | null): boolean {
  if (!startDate) return false;
  // Calendar grid dates are local — extract local date
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // Event dates are midnight UTC — extract UTC date
  const startOnly = utcDateOnly(startDate);
  const endOnly = endDate ? utcDateOnly(endDate) : startOnly;
  return dateOnly >= startOnly && dateOnly <= endOnly;
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Calendar event-type palette. Categorical colors (NOT design-system
// tokens) — see [[feedback_smart_crop_wrong_for_posters]] for the
// category-vs-info distinction. These render the same in light/dark
// (the calendar grid bg differs, but the event chip stays vivid).
const CALENDAR_EVENT_COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-indigo-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-cyan-500",
] as const;

/**
 * Map an event-category string to a stable palette index so all
 * "Festival" events get one color, all "Craft Fair" events get
 * another, etc. (Google Calendar's "My calendars" pattern — color
 * communicates type at a glance instead of being noise.)
 *
 * Same hash function as the per-event id fallback so the palette
 * spread looks similar; mod-by-palette-size ensures we always land
 * on a real slot.
 */
function paletteIndexForCategory(category: string): number {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % CALENDAR_EVENT_COLORS.length;
}

/**
 * Pick a calendar chip color for an event.
 *
 * Calendar UX improvement (2026-06-08, per MMATF-UIUX-Calendar-Spec §3
 * "Color dimension → event category"): prefer category-derived color so
 * the grid reads as a typed view ("oh that orange block is the same
 * weekend market type as the one Tuesday"). Falls back to the legacy
 * per-event-id hash when categories aren't available, keeping color
 * stability for events not yet categorized.
 */
function getEventColor(eventId: string, categories?: string[] | null): string {
  if (categories && categories.length > 0) {
    return CALENDAR_EVENT_COLORS[paletteIndexForCategory(categories[0]!)]!;
  }
  let hash = 0;
  for (let i = 0; i < eventId.length; i++) {
    hash = eventId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return CALENDAR_EVENT_COLORS[Math.abs(hash) % CALENDAR_EVENT_COLORS.length]!;
}

interface CalendarViewProps {
  events: EventWithRelations[];
  currentDate: Date;
  onDateChange: (date: Date) => void;
  calendarViewType: CalendarViewType;
  onViewTypeChange: (type: CalendarViewType) => void;
  // F3.1 (Dev-Email-2026-06-09 §D, 2026-06-09) — category-legend
  // filter. Hoisted to parent EventsView so future surfaces (cards,
  // table) can reuse the same exclusion. Set<string> rather than
  // array so toggling is O(1) and the order matches the legend's
  // alphabetical sort (no implicit reordering).
  excludedCategories: Set<string>;
  onExcludedCategoriesChange: (next: Set<string>) => void;
  // F3 C2 (2026-06-11) — admin calendar host. Enables empty-cell "+ Add event"
  // affordances and the admin add-link inside the day popover. Public calendars
  // pass false (the default); empty days stay inert for them.
  isAdmin?: boolean;
}

// Additional helper functions for calendar views
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortMonth(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short" });
}

function getEventsForDate(events: EventWithRelations[], date: Date): EventWithRelations[] {
  return events.filter((event) => {
    // Discontinuous events with explicit per-day rows — render a chip
    // on each actual occurrence date. Unchanged from before.
    if (event.discontinuousDates && event.eventDayDates?.length) {
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return event.eventDayDates.includes(dateStr);
    }
    // Cohort 7 (C4/U4, 2026-06-01) — for continuous multi-day events
    // (a 5-day fair, a 30-day market season with no event_days), render
    // a chip ONLY on the first day of the span. Previously this branch
    // returned true for every cell in the range, which flooded the
    // calendar (one event rendered 63x in a single month, per the
    // dev-email C4 finding — United Farmers Market case).
    //
    // A full Google-Calendar-style spanning bar is a follow-up — the
    // mcw-calendar-grid render API doesn't expose cross-cell layout
    // primitives, and the renderDayNumber/renderDayContent callbacks
    // are per-cell. For now: one chip on the start date with the date
    // range available via popover. Visual span is lost but flooding is
    // gone, and accurate-per-occurrence rendering remains correct for
    // event_days-backed events (the more common shape).
    const startDate = event.startDate ? new Date(event.startDate) : null;
    if (!startDate) return false;
    const endDate = event.endDate ? new Date(event.endDate) : startDate;
    // If the cell is BEFORE the start or AFTER the end, definitely no.
    if (!isDateInRange(date, startDate, endDate)) return false;
    // If start == end (single-day event), the in-range check is
    // sufficient — single chip on the single day.
    if (!endDate || startDate.getTime() === endDate.getTime()) return true;
    // Multi-day continuous: render only on the start date. Use
    // year+month+day comparison to avoid timezone surprises (events
    // store UTC, but the calendar cell `date` is constructed local).
    return (
      date.getFullYear() === startDate.getUTCFullYear() &&
      date.getMonth() === startDate.getUTCMonth() &&
      date.getDate() === startDate.getUTCDate()
    );
  });
}

function CalendarView({
  events,
  currentDate,
  onDateChange,
  calendarViewType,
  onViewTypeChange,
  excludedCategories,
  onExcludedCategoriesChange,
  isAdmin = false,
}: CalendarViewProps) {
  const setCurrentDate = onDateChange;
  const setCalendarViewType = onViewTypeChange;

  // F3.1 — derive the legend's category list once per `events` change.
  // Events with NO categories are always visible (no synthetic
  // "Uncategorized" pill — see plan §D answer to John Q4).
  // Alphabetical sort so the legend is stable across page loads and
  // doesn't reorder when a single event is added/removed.
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const event of events) {
      const cats = parseJsonArray(event.categories);
      for (const c of cats) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [events]);

  // F3.1 — apply the exclusion filter. Events with no categories are
  // visible regardless of exclusion (no category to filter on).
  const visibleEvents = useMemo(() => {
    if (excludedCategories.size === 0) return events;
    return events.filter((e) => {
      const cats = parseJsonArray(e.categories);
      if (cats.length === 0) return true;
      // Visible if AT LEAST ONE of the event's categories is NOT excluded
      // (matches the "show events tagged with any visible category"
      // semantic — hiding "Festival" doesn't hide an event also tagged
      // "Craft Fair" if Craft Fair is still visible).
      return cats.some((c) => !excludedCategories.has(c));
    });
  }, [events, excludedCategories]);

  // F3.1 — handler closure for toggling a category pill.
  const toggleCategory = useCallback(
    (cat: string) => {
      const next = new Set(excludedCategories);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      onExcludedCategoriesChange(next);
    },
    [excludedCategories, onExcludedCategoriesChange]
  );
  const [popoverEvent, setPopoverEvent] = useState<{
    event: EventWithRelations;
    anchor: { x: number; y: number };
  } | null>(null);
  const [dayEventsPopover, setDayEventsPopover] = useState<{
    date: Date;
    events: EventWithRelations[];
    anchor: { x: number; y: number };
  } | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const today = new Date();

  // F3.2 (Dev-Email-2026-06-09 §D, 2026-06-09) — "Now: HH:MM" text label
  // shown in today's day/week column. Per plan §D answer to John Q1:
  // the current week/day views don't have an hours grid (they render
  // stacked chip lists), so a literal horizontal time line has nothing
  // to draw against. The label honors the spec's intent without
  // requiring a multi-day grid refactor. Computed once per render so
  // it updates when the calendar re-renders (date change, legend
  // toggle, page navigation) — no minute tick. Acceptable: granularity
  // of "what minute is it now" matters less than "is today now."
  const nowLabel = today.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  // Dismiss all popovers on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPopoverEvent(null);
        setDayEventsPopover(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const openEventPopover = useCallback((e: React.MouseEvent, event: EventWithRelations) => {
    e.preventDefault();
    e.stopPropagation();
    setDayEventsPopover(null);
    setPopoverEvent({ event, anchor: { x: e.clientX, y: e.clientY } });
  }, []);

  // Navigation functions
  const navigate = (direction: "prev" | "next") => {
    const d = new Date(currentDate);
    switch (calendarViewType) {
      case "day":
        d.setDate(d.getDate() + (direction === "next" ? 1 : -1));
        break;
      case "week":
        d.setDate(d.getDate() + (direction === "next" ? 7 : -7));
        break;
      case "month":
        d.setMonth(d.getMonth() + (direction === "next" ? 1 : -1));
        break;
      case "year":
        d.setFullYear(d.getFullYear() + (direction === "next" ? 1 : -1));
        break;
      case "schedule":
        d.setMonth(d.getMonth() + (direction === "next" ? 1 : -1));
        break;
    }
    setCurrentDate(d);
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  // Get title based on view type
  const getTitle = (): string => {
    switch (calendarViewType) {
      case "day":
        return formatFullDate(currentDate);
      case "week":
        const weekStart = getWeekStart(currentDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        if (weekStart.getMonth() === weekEnd.getMonth()) {
          return `${formatShortMonth(weekStart)} ${weekStart.getDate()} - ${weekEnd.getDate()}, ${weekStart.getFullYear()}`;
        }
        return `${formatShortMonth(weekStart)} ${weekStart.getDate()} - ${formatShortMonth(weekEnd)} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
      case "month":
        return formatMonthYear(currentDate);
      case "year":
        return year.toString();
      case "schedule":
        return formatMonthYear(currentDate);
    }
  };

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const viewOptions: { value: CalendarViewType; label: string }[] = [
    { value: "day", label: "Day" },
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
    { value: "year", label: "Year" },
    { value: "schedule", label: "Schedule" },
  ];

  // Render Day View
  const renderDayView = () => {
    const dayEvents = getEventsForDate(visibleEvents, currentDate);

    return (
      <div className="border-t border-border">
        <div className="text-center py-2 border-b border-border bg-muted">
          <div className="text-sm text-muted-foreground">
            {currentDate.toLocaleDateString("en-US", { weekday: "long" })}
          </div>
          <div
            className={`text-2xl font-semibold ${isSameDay(currentDate, today) ? "text-royal" : "text-foreground"}`}
          >
            {currentDate.getDate()}
          </div>
          {/* F3.2 — "Now: HH:MM" label. Rendered only when the day
              view is showing today; updates on view re-render. */}
          {isSameDay(currentDate, today) && (
            <div className="text-xs text-muted-foreground mt-0.5 print:hidden">Now: {nowLabel}</div>
          )}
        </div>
        <div className="max-h-[600px] overflow-y-auto print:max-h-none print:overflow-visible">
          {dayEvents.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              No events scheduled for this day
            </div>
          ) : (
            <div className="divide-y divide-border">
              {dayEvents.map((event) => (
                <button
                  key={event.id}
                  onClick={(e) => openEventPopover(e, event)}
                  className="block w-full text-left p-4 hover:bg-muted transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-1 h-full min-h-[40px] rounded ${getEventColor(event.id, parseJsonArray(event.categories))}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground">{event.name}</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {formatDateRange(event.startDate, event.endDate)}
                      </div>
                      {event.venue && (
                        <div className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                          <MapPin className="w-3 h-3" />
                          {event.venue.name}, {event.venue.city}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Render Week View
  const renderWeekView = () => {
    const weekStart = getWeekStart(currentDate);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    });

    return (
      <div>
        {/* Week day headers */}
        <div className="grid grid-cols-7 border-b border-border bg-muted">
          {days.map((day, i) => (
            <div
              key={i}
              className="py-2 print:py-1 text-center border-r border-border last:border-r-0"
            >
              <div className="text-xs print:text-[0.6rem] text-muted-foreground uppercase">
                {weekDays[i]}
              </div>
              <button
                onClick={() => {
                  setCurrentDate(day);
                  setCalendarViewType("day");
                }}
                className={`text-lg print:text-sm font-semibold cursor-pointer hover:bg-muted rounded-full w-8 h-8 flex items-center justify-center mx-auto transition-colors ${isSameDay(day, today) ? "bg-secondary text-secondary-foreground hover:bg-secondary/90" : "text-foreground"}`}
              >
                {day.getDate()}
              </button>
              {/* F3.2 — "Now: HH:MM" label. Only renders in today's
                  column; updates on view re-render. */}
              {isSameDay(day, today) && (
                <div className="text-[0.65rem] text-muted-foreground mt-0.5 print:hidden">
                  Now: {nowLabel}
                </div>
              )}
            </div>
          ))}
        </div>
        {/* Week grid */}
        <div className="grid grid-cols-7 min-h-[400px] print:min-h-0">
          {days.map((day, i) => {
            const dayEvents = getEventsForDate(visibleEvents, day);
            return (
              <div key={i} className="border-r border-border last:border-r-0 p-1 print:p-px">
                {/* Screen: capped at 5 events */}
                <div className="space-y-1 print:hidden">
                  {dayEvents.slice(0, 5).map((event) => (
                    <button
                      key={event.id}
                      onClick={(e) => openEventPopover(e, event)}
                      className={`block w-full text-left px-1.5 py-1 text-xs text-white rounded truncate ${getEventColor(event.id, parseJsonArray(event.categories))} hover:opacity-80 transition-opacity ${event.status === "TENTATIVE" ? "border border-dashed border-white/60" : ""}`}
                      title={
                        event.status === "TENTATIVE" ? `${event.name} (Tentative)` : event.name
                      }
                    >
                      {event.name}
                    </button>
                  ))}
                  {dayEvents.length > 5 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setDayEventsPopover({
                          date: day,
                          events: dayEvents,
                          anchor: { x: rect.left, y: rect.bottom },
                        });
                      }}
                      className="text-xs text-muted-foreground px-1.5 hover:text-navy transition-colors"
                    >
                      +{dayEvents.length - 5} more
                    </button>
                  )}
                </div>
                {/* Print: show all events */}
                <div className="hidden print:block space-y-0">
                  {dayEvents.map((event) => (
                    <Link
                      key={event.id}
                      href={`/events/${event.slug}`}
                      className={`block px-0.5 py-0 text-[0.55rem] leading-tight text-white rounded truncate ${getEventColor(event.id, parseJsonArray(event.categories))}`}
                      title={event.name}
                    >
                      {event.name}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render Month View — uses shared @johntarbox/calendar-grid package
  const renderMonthDayContent = useCallback(
    (day: CalendarDay) => {
      if (!day.inMonth) return null;
      const parsedDate = new Date(
        parseInt(day.date.slice(0, 4)),
        parseInt(day.date.slice(5, 7)) - 1,
        parseInt(day.date.slice(8, 10))
      );
      const dayEvents = getEventsForDate(visibleEvents, parsedDate);

      // F3 C2 — open the day popover (event list + admin add-link) anchored at
      // the click. Used by the empty-space overlay and the admin empty-day cell.
      const openDay = (e: React.MouseEvent) => {
        e.stopPropagation();
        setPopoverEvent(null);
        setDayEventsPopover({
          date: parsedDate,
          events: dayEvents,
          anchor: { x: e.clientX, y: e.clientY },
        });
      };

      // Empty day. Public → nothing (cell stays inert). Admin → a focusable
      // "+ add" button (min-height so it's a tangible target even when the cell
      // has no chips) that opens the day popover to create an event here.
      if (dayEvents.length === 0) {
        if (!isAdmin) return null;
        return (
          <button
            type="button"
            onClick={openDay}
            aria-label={`Add an event on ${parsedDate.toLocaleDateString()}`}
            className="group flex min-h-[3rem] w-full items-start p-1 print:hidden"
          >
            <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100">
              <Plus className="h-3 w-3" /> add
            </span>
          </button>
        );
      }

      return (
        <>
          {/* Screen: capped at 3 events */}
          <div className="space-y-0.5 print:hidden">
            {dayEvents.slice(0, 3).map((event) => (
              <button
                key={event.id}
                onClick={(e) => openEventPopover(e, event)}
                className={`block w-full text-left px-1.5 py-0.5 text-xs text-white rounded truncate ${getEventColor(event.id, parseJsonArray(event.categories))} hover:opacity-80 transition-opacity ${event.status === "TENTATIVE" ? "border border-dashed border-white/60" : ""}`}
                title={event.status === "TENTATIVE" ? `${event.name} (Tentative)` : event.name}
              >
                {event.name}
              </button>
            ))}
            {dayEvents.length > 3 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDayEventsPopover({
                    date: parsedDate,
                    events: dayEvents,
                    anchor: { x: rect.left, y: rect.bottom },
                  });
                }}
                className="block w-full text-left px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted rounded"
              >
                +{dayEvents.length - 3} more
              </button>
            )}
            {/* F3 C2 — admin "+ add event" on populated days too. Opens the day
                popover (which lists these events + the prefilled add link), so
                an operator can schedule another event on a day that already has
                some. Focusable, no invisible overlay → no a11y/height risk. */}
            {isAdmin && (
              <button
                type="button"
                onClick={openDay}
                className="flex w-full items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.65rem] text-muted-foreground transition-colors hover:bg-muted"
              >
                <Plus className="h-3 w-3" /> add event
              </button>
            )}
          </div>
          {/* Print: show all events */}
          <div className="hidden print:block space-y-0">
            {dayEvents.map((event) => (
              <Link
                key={event.id}
                href={`/events/${event.slug}`}
                className={`block px-0.5 py-0 text-[0.55rem] leading-tight text-white rounded truncate ${getEventColor(event.id, parseJsonArray(event.categories))}`}
                title={event.name}
              >
                {event.name}
              </Link>
            ))}
          </div>
        </>
      );
    },
    [visibleEvents, openEventPopover, setDayEventsPopover, isAdmin]
  );

  const handleMonthChange = useCallback(
    (newYear: number, newMonth: number) => {
      setCurrentDate(new Date(newYear, newMonth, 1));
    },
    [setCurrentDate]
  );

  const renderMonthDayNumber = useCallback(
    (day: CalendarDay) => {
      const dateObj = new Date(
        parseInt(day.date.slice(0, 4)),
        parseInt(day.date.slice(5, 7)) - 1,
        parseInt(day.date.slice(8, 10))
      );
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setCurrentDate(dateObj);
            setCalendarViewType("day");
          }}
          className={`inline-flex h-6 w-6 items-center justify-center text-xs rounded-full transition-colors cursor-pointer ${
            day.isToday
              ? "bg-secondary text-secondary-foreground font-semibold hover:bg-secondary/90"
              : day.inMonth
                ? "font-medium text-foreground hover:bg-muted"
                : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {day.day}
        </button>
      );
    },
    [setCurrentDate, setCalendarViewType]
  );

  const renderMonthView = () => (
    <MonthCalendar
      hideHeader
      year={year}
      month={month}
      onMonthChange={handleMonthChange}
      renderDayContent={renderMonthDayContent}
      renderDayNumber={renderMonthDayNumber}
      cellMinHeight="100px"
      todayClassName="rounded-full bg-secondary text-secondary-foreground font-semibold"
      className="border-0 rounded-none shadow-none"
    />
  );

  // Render Year View
  const renderYearView = () => {
    const months = Array.from({ length: 12 }, (_, i) => i);

    return (
      <div className="grid grid-cols-3 md:grid-cols-4 gap-4 p-4">
        {months.map((monthIndex) => {
          const monthDate = new Date(year, monthIndex, 1);
          const daysInMonth = getDaysInMonth(year, monthIndex);
          const firstDay = getFirstDayOfMonth(year, monthIndex);
          const monthEvents = events.filter((event) => {
            const startDate = event.startDate ? utcDateOnly(new Date(event.startDate)) : null;
            const endDate = event.endDate ? utcDateOnly(new Date(event.endDate)) : startDate;
            if (!startDate) return false;
            const monthStart = new Date(year, monthIndex, 1);
            const monthEnd = new Date(year, monthIndex + 1, 0);
            return startDate <= monthEnd && (endDate || startDate) >= monthStart;
          });

          const miniDays: (number | null)[] = [];
          for (let i = 0; i < firstDay; i++) miniDays.push(null);
          for (let d = 1; d <= daysInMonth; d++) miniDays.push(d);

          return (
            <div
              key={monthIndex}
              className="bg-card border border-border rounded-lg overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => {
                setCurrentDate(new Date(year, monthIndex, 1));
                setCalendarViewType("month");
              }}
            >
              <div className="bg-muted px-3 py-2 border-b border-border">
                <div className="text-sm font-medium text-foreground">
                  {monthDate.toLocaleDateString("en-US", { month: "long" })}
                </div>
                {monthEvents.length > 0 && (
                  <div className="text-xs text-royal">
                    {monthEvents.length} event{monthEvents.length !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
              <div className="p-2">
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <div key={i} className="text-[10px] text-muted-foreground font-medium">
                      {d}
                    </div>
                  ))}
                  {miniDays.slice(0, 42).map((day, i) => {
                    const hasEvent =
                      day !== null &&
                      getEventsForDate(visibleEvents, new Date(year, monthIndex, day)).length > 0;
                    const isCurrentDay =
                      day !== null && isSameDay(new Date(year, monthIndex, day), today);
                    return (
                      <div
                        key={i}
                        className={`text-[10px] w-5 h-5 flex items-center justify-center rounded-full ${
                          isCurrentDay
                            ? "bg-secondary text-secondary-foreground"
                            : hasEvent
                              ? "bg-amber-light text-amber-bg-fg"
                              : "text-foreground"
                        }`}
                      >
                        {day}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Render Schedule View
  const renderScheduleView = () => {
    // Get events for the current month and beyond, sorted by date
    const scheduleEvents = events
      .filter((event) => {
        const startDate = event.startDate ? utcDateOnly(new Date(event.startDate)) : null;
        if (!startDate) return false;
        const viewStart = new Date(year, month, 1);
        return (
          startDate >= viewStart ||
          (event.endDate && utcDateOnly(new Date(event.endDate)) >= viewStart)
        );
      })
      .sort((a, b) => {
        const aDate = a.startDate ? new Date(a.startDate).getTime() : Infinity;
        const bDate = b.startDate ? new Date(b.startDate).getTime() : Infinity;
        return aDate - bDate;
      });

    // Group events by date (use UTC to get correct calendar day)
    const groupedEvents: { [key: string]: EventWithRelations[] } = {};
    scheduleEvents.forEach((event) => {
      if (event.startDate) {
        const dateKey = utcDateOnly(new Date(event.startDate)).toDateString();
        if (!groupedEvents[dateKey]) {
          groupedEvents[dateKey] = [];
        }
        groupedEvents[dateKey].push(event);
      }
    });

    const sortedDates = Object.keys(groupedEvents).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime()
    );

    return (
      <div className="max-h-[600px] overflow-y-auto print:max-h-none print:overflow-visible">
        {sortedDates.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">No upcoming events</div>
        ) : (
          <div className="divide-y divide-border">
            {sortedDates.map((dateKey) => {
              const date = new Date(dateKey);
              const isCurrentDay = isSameDay(date, today);
              return (
                <div key={dateKey}>
                  <div
                    className={`sticky top-0 px-4 py-2 bg-muted border-b border-border ${isCurrentDay ? "bg-brand-blue-light" : ""}`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`text-2xl font-bold ${isCurrentDay ? "text-royal" : "text-foreground"}`}
                      >
                        {date.getDate()}
                      </div>
                      <div>
                        <div
                          className={`text-sm font-medium ${isCurrentDay ? "text-royal" : "text-foreground"}`}
                        >
                          {date.toLocaleDateString("en-US", { weekday: "long" })}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {date.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {groupedEvents[dateKey].map((event) => (
                      <button
                        key={event.id}
                        onClick={(e) => openEventPopover(e, event)}
                        className="block w-full text-left px-4 py-3 hover:bg-muted transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className={`w-1 h-full min-h-[40px] rounded ${getEventColor(event.id, parseJsonArray(event.categories))}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-foreground">{event.name}</div>
                            <div className="text-sm text-muted-foreground mt-1">
                              {formatDateRange(event.startDate, event.endDate)}
                            </div>
                            {event.venue && (
                              <div className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                                <MapPin className="w-3 h-3" />
                                {event.venue.name}, {event.venue.city}, {event.venue.state}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    /* `print-landscape` opts this container into the named landscape
       @page rule in globals.css (added in PR #400 to default @page to
       portrait for event-sheet prints). Without this class the
       calendar would print on portrait pages — too narrow for a
       month-grid. Chrome/Edge/Safari 14+ honor named pages; Firefox
       falls back to portrait (~3% market share, acceptable). */
    <div className="bg-card rounded-lg border border-border overflow-hidden print:border-0 print:rounded-none print:overflow-visible print-landscape">
      {/* Print-only title */}
      <div className="hidden print:block print:px-2 print:py-1 px-4 py-3 border-b border-border">
        <h1 className="text-xl font-bold text-foreground">Events Calendar — {getTitle()}</h1>
      </div>
      {/* Calendar Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted print:hidden">
        <div className="flex items-center gap-2">
          <button
            onClick={goToToday}
            className="px-3 py-1.5 text-sm font-medium text-foreground bg-card border border-border rounded-md hover:bg-muted transition-colors"
          >
            Today
          </button>
          <div className="flex items-center">
            <button
              onClick={() => navigate("prev")}
              className="p-1.5 text-muted-foreground hover:bg-muted rounded-full transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => navigate("next")}
              className="p-1.5 text-muted-foreground hover:bg-muted rounded-full transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <h2 className="text-lg font-semibold text-foreground ml-2">{getTitle()}</h2>
        </div>

        {/* View Type Selector */}
        <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-0.5">
          {viewOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setCalendarViewType(option.value)}
              className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                calendarViewType === option.value
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Calendar Content */}
      {calendarViewType === "day" && renderDayView()}
      {calendarViewType === "week" && renderWeekView()}
      {calendarViewType === "month" && renderMonthView()}
      {calendarViewType === "year" && renderYearView()}
      {calendarViewType === "schedule" && renderScheduleView()}

      {/* Event Popover */}
      {popoverEvent && (
        <EventPopover
          event={popoverEvent.event}
          anchor={popoverEvent.anchor}
          onClose={() => setPopoverEvent(null)}
          getEventColor={getEventColor}
        />
      )}

      {/* Day Events Popover */}
      {dayEventsPopover && (
        <DayEventsPopover
          date={dayEventsPopover.date}
          events={dayEventsPopover.events}
          anchor={dayEventsPopover.anchor}
          onClose={() => setDayEventsPopover(null)}
          onEventClick={(event, anchor) => {
            setDayEventsPopover(null);
            setPopoverEvent({ event, anchor });
          }}
          onViewDay={(date) => {
            setCurrentDate(date);
            setCalendarViewType("day");
          }}
          getEventColor={getEventColor}
          adminAddEventDate={isAdmin ? dayEventsPopover.date : undefined}
        />
      )}

      {/* Legend — F3.1 (Dev-Email-2026-06-09 §D, 2026-06-09): static
          help text replaced with category-toggleable pills. Year view
          keeps its informational tip (no chips to filter at that
          zoom). When there are zero categories present (events tagged
          only with `null` categories columns), render the pre-F3
          help-text fallback so the strip never reads empty. */}
      <div className="px-4 py-3 bg-muted border-t border-border print:hidden">
        {calendarViewType === "year" || allCategories.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {calendarViewType === "year"
              ? "Click on a month to view details. Highlighted days have events."
              : "Click an event for a preview. Click a date number to view that day. Multi-day events appear on each day."}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-1">Filter:</span>
            {allCategories.map((cat) => {
              const excluded = excludedCategories.has(cat);
              const swatchClass = CALENDAR_EVENT_COLORS[paletteIndexForCategory(cat)];
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  aria-pressed={!excluded}
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border transition-opacity ${
                    excluded
                      ? "bg-muted text-muted-foreground border-border opacity-60 line-through"
                      : "bg-card text-foreground border-border hover:bg-muted"
                  }`}
                  title={excluded ? `Show "${cat}" events` : `Hide "${cat}" events`}
                >
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${swatchClass}`} />
                  <span>{cat}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function EventsView({
  events,
  view = "cards",
  emptyMessage = "No events found",
  currentPage = 1,
  totalPages = 1,
  searchParams = {},
  total,
  myEvents = false,
  basePath = "/events",
  vendorCoords = null,
  isAdmin = false,
}: EventsViewProps) {
  const currentSearchParams = useSearchParams();
  const viewMode = view;
  const [calendarDate, setCalendarDate] = useState(new Date());
  // Calendar UX improvements (2026-06-08, per MMATF-UIUX-Calendar-Spec):
  //   - Initial state "month" matches the legacy default + works for SSR.
  //   - On mount we override from localStorage (last-used view) if
  //     present, else auto-default to "schedule" on phones per the spec
  //     ("Schedule (agenda) on phones; remember last-used view"). The
  //     phone threshold uses matchMedia(max-width: 768px) to stay in
  //     sync with the existing sm/md Tailwind breakpoint.
  //   - Subsequent changes persist back to localStorage so the next
  //     visit lands on whatever the user picked last.
  const [calendarViewType, setCalendarViewTypeRaw] = useState<CalendarViewType>("month");
  const CALENDAR_VIEW_STORAGE_KEY = "mmatf.calendar.viewType";
  // Read once on mount. Empty array deps = run-once, intended; we don't
  // re-read on URL changes because that would clobber a user's in-page
  // view switch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY);
      if (
        stored === "day" ||
        stored === "week" ||
        stored === "month" ||
        stored === "year" ||
        stored === "schedule"
      ) {
        setCalendarViewTypeRaw(stored);
        return;
      }
      // No stored preference — default by viewport.
      if (window.matchMedia && window.matchMedia("(max-width: 768px)").matches) {
        setCalendarViewTypeRaw("schedule");
      }
    } catch {
      // localStorage access can throw in some sandboxed contexts. Falls
      // back to the SSR default (month). Non-fatal.
    }
  }, []);
  // Wrapper that persists every change.
  const setCalendarViewType = useCallback((v: CalendarViewType) => {
    setCalendarViewTypeRaw(v);
    try {
      window.localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, v);
    } catch {
      // Same swallow as above — persistence is best-effort.
    }
  }, []);

  // F3.1 (Dev-Email-2026-06-09 §D, 2026-06-09) — category-legend
  // exclusion set, hoisted to parent so it survives the calendar-view
  // remount when user switches month/week/day/year and so list/cards
  // surfaces can opt into the same filter later. localStorage key
  // mirrors the calendarViewType pattern above.
  const CALENDAR_EXCLUDED_CATS_STORAGE_KEY = "mmatf.calendar.excludedCategories";
  const [excludedCategories, setExcludedCategoriesRaw] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(CALENDAR_EXCLUDED_CATS_STORAGE_KEY);
      if (!stored) return;
      const arr = JSON.parse(stored);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        setExcludedCategoriesRaw(new Set(arr));
      }
    } catch {
      // Bad JSON or sandboxed storage — keep the empty default.
    }
  }, []);
  // Wrapper persists every change as a JSON array (Set is not
  // JSON-serializable directly).
  const setExcludedCategories = useCallback((next: Set<string>) => {
    setExcludedCategoriesRaw(next);
    try {
      window.localStorage.setItem(
        CALENDAR_EXCLUDED_CATS_STORAGE_KEY,
        JSON.stringify(Array.from(next))
      );
    } catch {
      // Best-effort, same pattern as calendarViewType persistence.
    }
  }, []);

  const switchView = (newView: string) => {
    const params = new URLSearchParams(currentSearchParams.toString());
    params.set("view", newView);
    params.delete("page");
    window.location.href = `${basePath}?${params.toString()}`;
  };

  const switchSort = (newSort: string) => {
    const params = new URLSearchParams(currentSearchParams.toString());
    params.set("sort", newSort);
    params.delete("page");
    window.location.href = `${basePath}?${params.toString()}`;
  };

  const currentSort = currentSearchParams.get("sort") || "date-asc";

  const [sortConfig, setSortConfig] = useState<SortConfig>({
    column: "startDate",
    direction: "asc",
  });

  const handleSort = (column: string) => {
    setSortConfig(getNextSortDirection(sortConfig, column));
  };

  const downloadCSV = () => {
    // Get current URL search params (preserves filters) but remove pagination
    const currentParams = new URLSearchParams(window.location.search);
    currentParams.delete("page"); // Remove pagination for full export

    // Navigate to the export API endpoint with current filters
    const exportUrl = `/api/events/export?${currentParams.toString()}`;
    window.location.href = exportUrl;
  };

  // Distance filter & computation
  const [browserCoords, setBrowserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [maxRadius, setMaxRadius] = useState<number | null>(null);
  const activeCoords = vendorCoords || browserCoords;

  const distanceMap = new Map<string, number>();
  if (activeCoords) {
    for (const event of events) {
      if (event.venue?.latitude && event.venue?.longitude) {
        distanceMap.set(
          event.id,
          haversineDistance(
            activeCoords.lat,
            activeCoords.lng,
            event.venue.latitude,
            event.venue.longitude
          )
        );
      }
    }
  }

  const sortedEvents = sortData(events, sortConfig, {
    name: (e) => e.name.toLowerCase(),
    venue: (e) => e.venue?.name?.toLowerCase() || "",
    city: (e) => e.venue?.city?.toLowerCase() || "",
    state: (e) => e.venue?.state || "",
    // Put null dates at the end by using Infinity for asc sort
    startDate: (e) => (e.startDate ? new Date(e.startDate).getTime() : Infinity),
    endDate: (e) => (e.endDate ? new Date(e.endDate).getTime() : Infinity),
  });

  // Apply client-side radius filter and "nearest" sort
  const radiusFiltered =
    maxRadius && activeCoords
      ? (currentSort === "nearest" ? [...events] : sortedEvents).filter((e) => {
          const dist = distanceMap.get(e.id);
          return dist != null && dist <= maxRadius;
        })
      : currentSort === "nearest" && activeCoords
        ? [...events]
        : sortedEvents;

  const displayEvents =
    currentSort === "nearest" && activeCoords
      ? radiusFiltered.sort((a, b) => {
          const distA = distanceMap.get(a.id) ?? Infinity;
          const distB = distanceMap.get(b.id) ?? Infinity;
          return distA - distB;
        })
      : radiusFiltered;

  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  const summaryText = (() => {
    const suffix = myEvents ? " you're participating in" : "";
    const radiusSuffix = maxRadius && activeCoords ? ` within ${maxRadius} mi` : "";
    if (viewMode === "calendar") {
      const { count, label } = getCalendarPeriodSummary(events, calendarViewType, calendarDate);
      if (calendarViewType === "schedule") {
        return `Showing all ${count} event${count !== 1 ? "s" : ""}${suffix} ${label}`;
      }
      return `Showing ${count} event${count !== 1 ? "s" : ""}${suffix} ${label}`;
    }
    if (maxRadius && activeCoords && total !== undefined) {
      return `Showing ${displayEvents.length} event${displayEvents.length !== 1 ? "s" : ""}${radiusSuffix}${suffix} (${total} total)`;
    }
    if (total !== undefined) {
      return `Showing ${events.length} of ${total} event${total !== 1 ? "s" : ""}${suffix}`;
    }
    return null;
  })();

  return (
    <div>
      {/* Summary Text */}
      {summaryText && (
        <p className="text-sm text-muted-foreground mb-4 print:hidden">{summaryText}</p>
      )}

      {/* Sort, View Toggle, and Download */}
      <div className="flex justify-end items-center gap-3 mb-4 print:hidden">
        <select
          value={currentSort}
          onChange={(e) => {
            const val = e.target.value;
            trackFilterApplied("sort", val, "events");
            if (val === "nearest" && !activeCoords) {
              // Request browser geolocation then apply sort
              navigator.geolocation?.getCurrentPosition(
                (pos) => {
                  setBrowserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                  switchSort("nearest");
                },
                () => {
                  // Geolocation denied — fall back
                  switchSort("date-asc");
                }
              );
              return;
            }
            switchSort(val);
          }}
          className="text-sm border border-border rounded-md px-2 py-1.5 bg-card text-muted-foreground focus:outline-none focus:ring-2 focus:ring-royal focus:border-transparent"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          value={maxRadius ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            trackFilterApplied("radius", val || "any", "events");
            if (!val) {
              setMaxRadius(null);
              return;
            }
            const radius = parseInt(val);
            if (!activeCoords) {
              navigator.geolocation?.getCurrentPosition(
                (pos) => {
                  setBrowserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                  setMaxRadius(radius);
                },
                () => setMaxRadius(null)
              );
              return;
            }
            setMaxRadius(radius);
          }}
          className="text-sm border border-border rounded-md px-2 py-1.5 bg-card text-muted-foreground focus:outline-none focus:ring-2 focus:ring-royal focus:border-transparent mr-auto"
        >
          <option value="">Any distance</option>
          <option value="25">Within 25 mi</option>
          <option value="50">Within 50 mi</option>
          <option value="100">Within 100 mi</option>
          <option value="200">Within 200 mi</option>
        </select>
        {viewMode === "table" && (
          <button
            onClick={downloadCSV}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted border border-border bg-card transition-colors"
          >
            <Download className="w-4 h-4" />
            Download CSV
          </button>
        )}
        {viewMode === "calendar" && (
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted border border-border bg-card transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
        )}
        <div className="inline-flex rounded-lg border border-border p-1 bg-card">
          <button
            onClick={() => switchView("cards")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "cards"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Cards
          </button>
          <button
            onClick={() => switchView("table")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "table"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <Table className="w-4 h-4" />
            Table
          </button>
          <button
            onClick={() => switchView("calendar")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "calendar"
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <CalendarIcon className="w-4 h-4" />
            Calendar
          </button>
        </div>
      </div>

      {/* Cards View */}
      {viewMode === "cards" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {displayEvents.map((event, index) => (
            // IMG-followup (2026-06-08) — exactly one preload per page
            // (index === 0). Cards 1-N use Next/Image default lazy;
            // earlier eagerLoad attempt reverted (Next.js 15.x emits
            // preload for loading="eager" too).
            <EventCard
              key={event.id}
              event={event}
              priority={index === 0}
              distance={distanceMap.get(event.id)}
            />
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === "table" && (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <SortableHeader
                    column="name"
                    label="Event"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="venue"
                    label="Venue"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="city"
                    label="City"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    column="state"
                    label="State"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                    className="w-20"
                  />
                  <SortableHeader
                    column="startDate"
                    label="Dates"
                    sortConfig={sortConfig}
                    onSort={handleSort}
                  />
                  <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground w-24">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedEvents.map((event) => (
                  <tr key={event.id} className="hover:bg-muted">
                    <td className="py-3 px-4">
                      <Link
                        href={`/events/${event.slug}`}
                        className="font-medium text-foreground hover:text-navy"
                      >
                        {event.name}
                      </Link>
                      {/* UX-R3 (2026-06-07) — consolidated to <Badge variant="warning">,
                          which now renders amber-light + amber-bg-fg (~17:1 contrast)
                          via the badge.tsx token migration. Matches the card-variant
                          Featured badge at event-card.tsx:137 for visual consistency
                          across grid + list views. */}
                      {event.featured && (
                        <Badge variant="warning" className="ml-2">
                          Featured
                        </Badge>
                      )}
                      {event.status === "TENTATIVE" && (
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-brand-blue-light text-navy-dark">
                          Tentative
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {event.venue?.name || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {event.venue?.city || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {event.venue?.state || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                        {formatDateRange(event.startDate, event.endDate)}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/events/${event.slug}`}
                          className="text-royal hover:text-navy-dark text-sm font-medium"
                        >
                          View
                        </Link>
                        {event.ticketUrl && (
                          <a
                            href={event.ticketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-muted-foreground"
                            title="Event Website"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Calendar View */}
      {viewMode === "calendar" && (
        <CalendarView
          events={events}
          currentDate={calendarDate}
          onDateChange={setCalendarDate}
          calendarViewType={calendarViewType}
          onViewTypeChange={setCalendarViewType}
          excludedCategories={excludedCategories}
          onExcludedCategoriesChange={setExcludedCategories}
          isAdmin={isAdmin}
        />
      )}

      {/* Pagination - only shown for cards/table views, not calendar */}
      {viewMode !== "calendar" && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          basePath={basePath}
          searchParams={searchParams}
        />
      )}
    </div>
  );
}
