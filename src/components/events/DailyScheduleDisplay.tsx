"use client";

import { useState } from "react";
import { Clock, ChevronDown, ChevronRight } from "lucide-react";
import type { EventDay } from "@/types";
import { formatDateOnly, parseDateOnly } from "@/lib/datetime";
import { cadenceLabel, findNextUpcoming, inferCadence } from "@/lib/recurring-display";
import { areDatesContiguous } from "@takemetothefair/utils";

interface DailyScheduleDisplayProps {
  days: EventDay[];
  discontinuousDates?: boolean;
  className?: string;
  showVendorDays?: "hide" | "badge" | "all";
}

// Threshold above which the date list collapses by default to keep the
// sidebar compact. Below this we render every row inline — the analyst's
// 16-biweekly case was the trigger; ~6 is the boundary where the list
// becomes visually noisy in a sidebar card.
const COLLAPSE_DATE_THRESHOLD = 6;

/** DQ4 (2026-06-08) — event_days.openTime/closeTime are now nullable.
 *  NULL means "hours not yet confirmed" — render with a muted fallback
 *  instead of crashing on .split(":") of null. Returns null when the
 *  input is missing so callers can decide where to splice the fallback
 *  copy in. */
function formatTime(time24: string | null | undefined): string | null {
  if (!time24) return null;
  const [hours, minutes] = time24.split(":").map(Number);
  const period = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return minutes === 0
    ? `${hour12}${period}`
    : `${hour12}:${minutes.toString().padStart(2, "0")}${period}`;
}

/** DQ4 — uniform copy for the "no hours captured at ingest" state.
 *  Lives at module scope so PR 3's print sheet can re-import. */
const HOURS_UNKNOWN_COPY = "Hours not yet confirmed";

/** DQ4 — format a single day's open–close range for inline rendering.
 *  Either or both can be null. */
function formatRange(open: string | null | undefined, close: string | null | undefined): string {
  const o = formatTime(open);
  const c = formatTime(close);
  if (o && c) return `${o} - ${c}`;
  if (o) return o; // half-known, surface what we have
  if (c) return c;
  return HOURS_UNKNOWN_COPY;
}

function formatDateShort(dateStr: string): string {
  // parseDateOnly anchors to midnight UTC; formatDateOnly renders in UTC, so
  // the displayed date matches the input regardless of viewer timezone.
  return formatDateOnly(parseDateOnly(dateStr));
}

function allSameHours(days: EventDay[]): boolean {
  if (days.length <= 1) return true;
  const openDays = days.filter((d) => !d.closed);
  if (openDays.length === 0) return true;
  const first = openDays[0];
  // Two NULLs are "the same" (both unknown — render uniform fallback);
  // a NULL paired with a real time is NOT the same — those events should
  // surface per-day so the operator sees the gap.
  return openDays.every((d) => d.openTime === first.openTime && d.closeTime === first.closeTime);
}

/** DQ4 — true when every open day has both NULL openTime AND closeTime.
 *  When this holds, the simplified-path branch renders one "Hours not
 *  yet confirmed" line instead of repeating it per row. */
function allHoursUnknown(days: EventDay[]): boolean {
  const open = days.filter((d) => !d.closed);
  if (open.length === 0) return false;
  return open.every((d) => d.openTime == null && d.closeTime == null);
}

/** DQ-HOURS1 (2026-06-21) — true when the OPEN days form a gap-free,
 *  day-after-day run (each date is exactly one calendar day after the
 *  previous). The "Daily:" simplified label must reflect ACTUAL date
 *  contiguity computed from event_days, not the `discontinuous_dates` flag:
 *  a Saturdays-only market ingested as a single span with
 *  discontinuous_dates=0 was rendering "Daily:" despite week-long gaps. A
 *  closed day inside the range also breaks the run (it's not open daily).
 *
 *  OPE-47 (2026-07) — the contiguity math now lives in the shared, pure
 *  `areDatesContiguous` helper in @takemetothefair/utils so this display
 *  label and the ingest paths that set `events.discontinuous_dates` agree by
 *  construction (the stored flag is `!areDatesContiguous(dates)`). This
 *  wrapper keeps the EventDay-shaped call site and passes only the OPEN days'
 *  dates through. */
export function isContiguousDaily(openDays: EventDay[]): boolean {
  return areDatesContiguous(openDays.map((d) => d.date));
}

export function DailyScheduleDisplay({
  days,
  discontinuousDates = false,
  className = "",
  showVendorDays = "hide",
}: DailyScheduleDisplayProps) {
  if (!days || days.length === 0) {
    return null;
  }

  // Sort days by date
  const sortedDays = [...days].sort((a, b) => a.date.localeCompare(b.date));

  // Filter based on vendor-only visibility
  const visibleDays =
    showVendorDays === "hide" ? sortedDays.filter((d) => !d.vendorOnly) : sortedDays;
  const openDays = visibleDays.filter((d) => !d.closed);

  if (visibleDays.length === 0) {
    return null;
  }

  // For discontinuous events, always show per-day listing (users need to see which dates)
  // For contiguous events with same hours, show simplified display.
  // DQ-HOURS1: gate on COMPUTED contiguity (isContiguousDaily), not just the
  // discontinuous_dates flag — the flag is wrong on some ingested spans. The
  // flag stays as an additional suppressor so an explicitly-flagged event never
  // shows "Daily:" even if its stored dates happen to look contiguous.
  if (
    !discontinuousDates &&
    isContiguousDaily(openDays) &&
    allSameHours(visibleDays) &&
    openDays.length > 0
  ) {
    // Only use simplified display if no visible vendor-only days need badges
    const hasVendorDays = showVendorDays !== "hide" && visibleDays.some((d) => d.vendorOnly);
    if (!hasVendorDays) {
      const first = openDays[0];
      // DQ4: when all hours are null, render uniform "Hours not yet
      // confirmed" instead of "Daily: null - null". formatRange already
      // handles the partial-known case (e.g. open known, close null).
      return (
        <div className={className}>
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Clock className="w-4 h-4" />
            Daily: {formatRange(first.openTime, first.closeTime)}
          </p>
        </div>
      );
    }
  }

  return (
    <RecurringScheduleView
      visibleDays={visibleDays}
      openDays={openDays}
      showVendorDays={showVendorDays}
      className={className}
    />
  );
}

interface RecurringScheduleViewProps {
  visibleDays: EventDay[];
  openDays: EventDay[];
  showVendorDays: "hide" | "badge" | "all";
  className: string;
}

/** Polished schedule for discontinuous / multi-date events (analyst P7b).
 *  Leads with a plain-language cadence line, states uniform hours once when
 *  all days share them, surfaces the next upcoming date, and collapses long
 *  date lists behind a toggle. Falls back to the previous full-listing UI
 *  when none of those shortcuts apply. */
function RecurringScheduleView({
  visibleDays,
  openDays,
  showVendorDays,
  className,
}: RecurringScheduleViewProps) {
  const cadence = inferCadence(openDays.map((d) => d.date));
  const cadenceText = cadenceLabel(cadence, openDays.length);
  const uniformHours = allSameHours(visibleDays);
  const hasVendorBadges = showVendorDays !== "hide" && visibleDays.some((d) => d.vendorOnly);
  const longList = visibleDays.length > COLLAPSE_DATE_THRESHOLD;
  const nextUpcoming = findNextUpcoming(openDays.map((d) => d.date));

  // The full per-date list is kept in a useState-driven toggle so admins/
  // vendors can still see every date when needed without dominating the
  // sidebar by default. SSR renders collapsed (matches initial state) so
  // hydration is consistent.
  const [expanded, setExpanded] = useState(!longList);

  // DQ4: if every open day has unknown hours, surface "Hours not yet
  // confirmed" instead of "Open null – null". formatRange handles partial
  // information too (e.g. open known, close not).
  const summaryUniformHoursLabel =
    uniformHours && openDays.length > 0
      ? allHoursUnknown(openDays)
        ? HOURS_UNKNOWN_COPY
        : `Open ${formatRange(openDays[0].openTime, openDays[0].closeTime)}`
      : null;

  return (
    <div className={className}>
      {cadenceText && (
        <p className="text-sm font-medium text-foreground flex items-center gap-1">
          <Clock className="w-4 h-4 text-royal" />
          {cadenceText}
        </p>
      )}
      {summaryUniformHoursLabel && (
        <p className="text-sm text-muted-foreground mt-0.5">{summaryUniformHoursLabel}</p>
      )}
      {nextUpcoming && (
        <p className="text-sm text-muted-foreground mt-0.5">
          Next: <span className="font-medium text-foreground">{formatDateShort(nextUpcoming)}</span>
        </p>
      )}

      {/* Toggle is only useful when the list is long; otherwise render
          inline without the expander chrome. */}
      {longList && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 text-sm text-royal hover:text-navy flex items-center gap-1"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {expanded ? "Hide all dates" : `Show all ${visibleDays.length} dates`}
        </button>
      )}

      {expanded && (
        <div className="mt-2">
          {!cadenceText && (
            // Only show the legacy "Hours:" header when we have no cadence
            // line above; otherwise it's a redundant label for a list that
            // really shows dates, not hours.
            <p className="text-sm font-medium text-foreground mb-1">Dates:</p>
          )}
          <div className="space-y-1">
            {visibleDays.map((day) => {
              const showHours = !uniformHours || hasVendorBadges || day.closed;
              return (
                <div
                  key={day.id}
                  className={`flex items-start text-sm ${day.vendorOnly && showVendorDays === "badge" ? "text-amber-700" : ""}`}
                >
                  <span
                    className={`w-28 ${day.vendorOnly && showVendorDays === "badge" ? "text-amber-600" : "text-muted-foreground"}`}
                  >
                    {formatDateShort(day.date)}
                    {showHours ? ":" : ""}
                  </span>
                  {day.closed ? (
                    <span className="text-muted-foreground">Closed</span>
                  ) : showHours ? (
                    <span
                      className={
                        day.vendorOnly && showVendorDays === "badge"
                          ? "text-amber-700"
                          : "text-foreground"
                      }
                    >
                      {/* DQ4: formatRange handles all four cases
                          (both known / either-known / neither). The "hours
                          not yet confirmed" fallback lands on the same
                          baseline so the column alignment is stable. */}
                      {formatRange(day.openTime, day.closeTime)}
                      {/* UX-R3 (2026-06-07) — semantic-token migration. Shape kept
                          (text-xs, rounded not rounded-full) to match the inline
                          time-row layout; color pair moves to amber-light +
                          amber-bg-fg (~17:1 contrast vs the prior ~5:1). */}
                      {day.vendorOnly && showVendorDays === "badge" && (
                        <span className="ml-2 inline-flex items-center text-xs bg-amber-light text-amber-bg-fg px-1.5 py-0.5 rounded">
                          Vendor Setup
                        </span>
                      )}
                      {day.vendorOnly && showVendorDays === "all" && (
                        <span className="ml-2 text-xs text-amber-600">[Vendor Only]</span>
                      )}
                      {day.notes && (
                        <span className="text-muted-foreground ml-2">({day.notes})</span>
                      )}
                    </span>
                  ) : (
                    day.notes && (
                      <span className="text-muted-foreground text-sm">({day.notes})</span>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
