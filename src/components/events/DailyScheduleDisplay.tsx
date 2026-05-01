import { Clock } from "lucide-react";
import type { EventDay } from "@/types";
import { formatDateOnly, parseDateOnly } from "@/lib/datetime";

interface DailyScheduleDisplayProps {
  days: EventDay[];
  discontinuousDates?: boolean;
  className?: string;
  showVendorDays?: "hide" | "badge" | "all";
}

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

  // Show full per-day schedule
  return (
    <div className={className}>
      <p className="text-sm font-medium text-gray-700 mb-2">Hours:</p>
      <div className="space-y-1">
        {visibleDays.map((day) => (
          <div
            key={day.id}
            className={`flex items-start text-sm ${day.vendorOnly && showVendorDays === "badge" ? "text-amber-700" : ""}`}
          >
            <span
              className={`w-28 ${day.vendorOnly && showVendorDays === "badge" ? "text-amber-600" : "text-gray-600"}`}
            >
              {formatDateShort(day.date)}:
            </span>
            {day.closed ? (
              <span className="text-gray-400">Closed</span>
            ) : (
              <span
                className={
                  day.vendorOnly && showVendorDays === "badge" ? "text-amber-700" : "text-gray-900"
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
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
