"use client";

import { useState } from "react";
import { Clock, ChevronDown, ChevronRight } from "lucide-react";
import type { EventDay } from "@/types";
import { formatDateOnly, parseDateOnly } from "@/lib/datetime";
import { cadenceLabel, findNextUpcoming, inferCadence } from "@/lib/recurring-display";

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

function formatTime(time24: string): string {
  const [hours, minutes] = time24.split(":").map(Number);
  const period = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return minutes === 0
    ? `${hour12}${period}`
    : `${hour12}:${minutes.toString().padStart(2, "0")}${period}`;
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
  return openDays.every((d) => d.openTime === first.openTime && d.closeTime === first.closeTime);
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
  // For contiguous events with same hours, show simplified display
  if (!discontinuousDates && allSameHours(visibleDays) && openDays.length > 0) {
    // Only use simplified display if no visible vendor-only days need badges
    const hasVendorDays = showVendorDays !== "hide" && visibleDays.some((d) => d.vendorOnly);
    if (!hasVendorDays) {
      const first = openDays[0];
      return (
        <div className={className}>
          <p className="text-sm text-gray-500 flex items-center gap-1">
            <Clock className="w-4 h-4" />
            Daily: {formatTime(first.openTime)} - {formatTime(first.closeTime)}
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

  const summaryUniformHoursLabel =
    uniformHours && openDays.length > 0
      ? `Open ${formatTime(openDays[0].openTime)} – ${formatTime(openDays[0].closeTime)}`
      : null;

  return (
    <div className={className}>
      {cadenceText && (
        <p className="text-sm font-medium text-gray-700 flex items-center gap-1">
          <Clock className="w-4 h-4 text-royal" />
          {cadenceText}
        </p>
      )}
      {summaryUniformHoursLabel && (
        <p className="text-sm text-gray-600 mt-0.5">{summaryUniformHoursLabel}</p>
      )}
      {nextUpcoming && (
        <p className="text-sm text-gray-600 mt-0.5">
          Next: <span className="font-medium text-gray-900">{formatDateShort(nextUpcoming)}</span>
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
            <p className="text-sm font-medium text-gray-700 mb-1">Dates:</p>
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
                    className={`w-28 ${day.vendorOnly && showVendorDays === "badge" ? "text-amber-600" : "text-gray-600"}`}
                  >
                    {formatDateShort(day.date)}
                    {showHours ? ":" : ""}
                  </span>
                  {day.closed ? (
                    <span className="text-gray-600">Closed</span>
                  ) : showHours ? (
                    <span
                      className={
                        day.vendorOnly && showVendorDays === "badge"
                          ? "text-amber-700"
                          : "text-gray-900"
                      }
                    >
                      {formatTime(day.openTime)} - {formatTime(day.closeTime)}
                      {day.vendorOnly && showVendorDays === "badge" && (
                        <span className="ml-2 inline-flex items-center text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                          Vendor Setup
                        </span>
                      )}
                      {day.vendorOnly && showVendorDays === "all" && (
                        <span className="ml-2 text-xs text-amber-600">[Vendor Only]</span>
                      )}
                      {day.notes && <span className="text-gray-500 ml-2">({day.notes})</span>}
                    </span>
                  ) : (
                    day.notes && <span className="text-gray-500 text-sm">({day.notes})</span>
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
