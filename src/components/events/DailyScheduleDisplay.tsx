import { Clock } from "lucide-react";
import type { EventDay } from "@/types";

interface DailyScheduleDisplayProps {
  days: EventDay[];
  className?: string;
}

function formatTime(time24: string): string {
  const [hours, minutes] = time24.split(":").map(Number);
  const period = hours >= 12 ? "pm" : "am";
  const hour12 = hours % 12 || 12;
  return minutes === 0 ? `${hour12}${period}` : `${hour12}:${minutes.toString().padStart(2, "0")}${period}`;
}

function formatDateShort(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function allSameHours(days: EventDay[]): boolean {
  if (days.length <= 1) return true;
  const openDays = days.filter((d) => !d.closed);
  if (openDays.length === 0) return true;
  const first = openDays[0];
  return openDays.every(
    (d) => d.openTime === first.openTime && d.closeTime === first.closeTime
  );
}

export function DailyScheduleDisplay({ days, className = "" }: DailyScheduleDisplayProps) {
  if (!days || days.length === 0) {
    return null;
  }

  // Sort days by date
  const sortedDays = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const openDays = sortedDays.filter((d) => !d.closed);

  // If all days have the same hours, show simplified display
  if (allSameHours(sortedDays) && openDays.length > 0) {
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

  // Show full per-day schedule
  return (
    <div className={className}>
      <p className="text-sm font-medium text-gray-700 mb-2">Hours:</p>
      <div className="space-y-1">
        {sortedDays.map((day) => (
          <div key={day.id} className="flex items-start text-sm">
            <span className="w-28 text-gray-600">{formatDateShort(day.date)}:</span>
            {day.closed ? (
              <span className="text-gray-400">Closed</span>
            ) : (
              <span className="text-gray-900">
                {formatTime(day.openTime)} - {formatTime(day.closeTime)}
                {day.notes && (
                  <span className="text-gray-500 ml-2">({day.notes})</span>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
