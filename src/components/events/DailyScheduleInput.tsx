"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Copy, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Maximum number of event days allowed (SQLite variable limit is 999, with 7 vars per day = ~142 max)
const MAX_EVENT_DAYS = 100;

export interface EventDayInput {
  date: string; // YYYY-MM-DD
  openTime: string; // HH:MM
  closeTime: string; // HH:MM
  notes: string;
  closed: boolean;
}

interface DailyScheduleInputProps {
  startDate: string | null;
  endDate: string | null;
  initialDays?: EventDayInput[];
  onChange: (days: EventDayInput[]) => void;
  disabled?: boolean;
}

function formatDateDisplay(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00"); // Use noon to avoid timezone issues
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getDatesInRange(start: string, end: string): { dates: string[]; truncated: boolean } {
  const dates: string[] = [];
  const startDate = new Date(start + "T12:00:00");
  const endDate = new Date(end + "T12:00:00");

  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  // Truncate if exceeds max
  if (dates.length > MAX_EVENT_DAYS) {
    return { dates: dates.slice(0, MAX_EVENT_DAYS), truncated: true };
  }

  return { dates, truncated: false };
}

export function DailyScheduleInput({
  startDate,
  endDate,
  initialDays = [],
  onChange,
  disabled = false,
}: DailyScheduleInputProps) {
  const [enabled, setEnabled] = useState(initialDays.length > 0);
  const [days, setDays] = useState<EventDayInput[]>(initialDays);
  const [showTruncationWarning, setShowTruncationWarning] = useState(false);
  // Track if we've synced async initialDays (for edit page where data loads after mount)
  const initialDaysSyncedRef = useRef(initialDays.length > 0);

  // Generate days when dates change or feature is enabled
  useEffect(() => {
    if (!enabled || !startDate || !endDate) {
      setShowTruncationWarning(false);
      return;
    }

    // Parse dates from startDate/endDate (they might be datetime strings or date strings)
    const startStr = startDate.includes("T") ? startDate.split("T")[0] : startDate;
    const endStr = endDate.includes("T") ? endDate.split("T")[0] : endDate;
    const { dates, truncated } = getDatesInRange(startStr, endStr);
    setShowTruncationWarning(truncated);

    // Only regenerate if we don't have matching days already
    const existingDates = new Set(days.map((d) => d.date));
    const newDates = new Set(dates);
    const needsRegeneration =
      dates.length !== days.length ||
      dates.some((d) => !existingDates.has(d)) ||
      days.some((d) => !newDates.has(d.date));

    if (needsRegeneration) {
      // Preserve existing data for dates that overlap
      const existingDayMap = new Map(days.map((d) => [d.date, d]));
      const newDays = dates.map((date) => {
        const existing = existingDayMap.get(date);
        if (existing) return existing;
        return {
          date,
          openTime: "10:00",
          closeTime: "18:00",
          notes: "",
          closed: false,
        };
      });
      setDays(newDays);
    }
  }, [enabled, startDate, endDate, days]);

  // Notify parent of changes (multi-day only - single-day handles its own onChange)
  const isSingleDay =
    startDate &&
    endDate &&
    new Date(startDate).toDateString() === new Date(endDate).toDateString();

  useEffect(() => {
    // Skip for single-day events - they handle onChange directly
    if (isSingleDay) return;

    if (enabled) {
      onChange(days);
    } else {
      onChange([]);
    }
  }, [enabled, days, onChange, isSingleDay]);

  const handleToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEnabled(e.target.checked);
  }, []);

  const handleDayChange = useCallback(
    (index: number, field: keyof EventDayInput, value: string | boolean) => {
      setDays((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: value };
        return updated;
      });
    },
    []
  );

  const handleCopyFirstToAll = useCallback(() => {
    if (days.length === 0) return;
    const first = days[0];
    setDays((prev) =>
      prev.map((day) => ({
        ...day,
        openTime: first.openTime,
        closeTime: first.closeTime,
      }))
    );
  }, [days]);

  // Check if multi-day event
  const isMultiDay =
    startDate &&
    endDate &&
    new Date(startDate).toDateString() !== new Date(endDate).toDateString();

  // Single-day event: initialize days and notify parent
  useEffect(() => {
    if (!isSingleDay || !startDate) return;

    const dateStr = startDate.includes("T") ? startDate.split("T")[0] : startDate;

    // Check if initialDays has data we should use (async load from edit page)
    const hasInitialData = initialDays.length > 0;

    // Sync when initialDays arrives asynchronously (edit page loads data after mount)
    if (hasInitialData && !initialDaysSyncedRef.current) {
      initialDaysSyncedRef.current = true;
      const existing = initialDays[0];
      const newDay = {
        date: dateStr,
        openTime: existing.openTime,
        closeTime: existing.closeTime,
        notes: existing.notes || "",
        closed: existing.closed,
      };
      setDays([newDay]);
      onChange([newDay]);
      return;
    }

    // Initialize with defaults if no data yet
    if (days.length === 0 || days[0].date !== dateStr) {
      const newDay = {
        date: dateStr,
        openTime: "10:00",
        closeTime: "18:00",
        notes: "",
        closed: false,
      };
      setDays([newDay]);
      onChange([newDay]);
    }
  }, [isSingleDay, startDate, initialDays, days, onChange]);

  // Single-day event: show simplified hours input
  if (isSingleDay && startDate) {
    const dateStr = startDate.includes("T") ? startDate.split("T")[0] : startDate;
    const singleDay = days.length > 0 ? days[0] : {
      date: dateStr,
      openTime: "10:00",
      closeTime: "18:00",
      notes: "",
      closed: false,
    };

    const handleSingleDayChange = (field: keyof EventDayInput, value: string | boolean) => {
      const updated = { ...singleDay, date: dateStr, [field]: value };
      setDays([updated]);
      onChange([updated]); // Directly notify parent
    };

    return (
      <div className="space-y-4">
        <Label className="text-sm font-medium">Event Hours</Label>
        <div className="border rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="singleDayOpenTime" className="text-sm text-gray-600 w-12">
                Open
              </Label>
              <Input
                id="singleDayOpenTime"
                type="time"
                value={singleDay.openTime}
                onChange={(e) => handleSingleDayChange("openTime", e.target.value)}
                disabled={disabled}
                className="w-32"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="singleDayCloseTime" className="text-sm text-gray-600 w-12">
                Close
              </Label>
              <Input
                id="singleDayCloseTime"
                type="time"
                value={singleDay.closeTime}
                onChange={(e) => handleSingleDayChange("closeTime", e.target.value)}
                disabled={disabled}
                className="w-32"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="singleDayNotes" className="text-sm text-gray-600">
              Notes (optional)
            </Label>
            <Input
              id="singleDayNotes"
              type="text"
              value={singleDay.notes}
              onChange={(e) => handleSingleDayChange("notes", e.target.value)}
              placeholder="e.g., Early bird entry at 9:00 AM"
              disabled={disabled}
              className="mt-1"
              maxLength={200}
            />
          </div>
        </div>
      </div>
    );
  }

  // No dates selected yet
  if (!isMultiDay) {
    return null;
  }

  // Multi-day event: show toggle + daily schedule grid
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          id="enableDailySchedule"
          type="checkbox"
          checked={enabled}
          onChange={handleToggle}
          disabled={disabled}
          className="h-4 w-4 rounded border-gray-300"
        />
        <Label htmlFor="enableDailySchedule" className="font-normal">
          Different hours on each day
        </Label>
      </div>

      {showTruncationWarning && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-medium">Date range exceeds {MAX_EVENT_DAYS} days</p>
            <p className="mt-1">
              Daily schedules are limited to {MAX_EVENT_DAYS} days. Only the first {MAX_EVENT_DAYS} days
              will have individual schedule entries. Consider reducing the date range or disabling daily schedules.
            </p>
          </div>
        </div>
      )}

      {enabled && days.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 flex items-center justify-between border-b">
            <span className="text-sm font-medium text-gray-700">Daily Schedule</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopyFirstToAll}
              disabled={disabled || days.length < 2}
              className="text-xs"
            >
              <Copy className="w-3 h-3 mr-1" />
              Copy first to all
            </Button>
          </div>
          <div className="divide-y">
            {days.map((day, index) => (
              <div
                key={day.date}
                className={`px-4 py-3 grid grid-cols-[140px_auto_1fr] gap-4 items-center ${
                  day.closed ? "bg-gray-50" : ""
                }`}
              >
                <div className="text-sm font-medium text-gray-700">
                  {formatDateDisplay(day.date)}
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={day.closed}
                      onChange={(e) => handleDayChange(index, "closed", e.target.checked)}
                      disabled={disabled}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <span className="text-gray-600">Closed</span>
                  </label>

                  {!day.closed && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={day.openTime}
                        onChange={(e) => handleDayChange(index, "openTime", e.target.value)}
                        disabled={disabled}
                        className="w-28"
                      />
                      <span className="text-gray-500">to</span>
                      <Input
                        type="time"
                        value={day.closeTime}
                        onChange={(e) => handleDayChange(index, "closeTime", e.target.value)}
                        disabled={disabled}
                        className="w-28"
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={day.notes}
                    onChange={(e) => handleDayChange(index, "notes", e.target.value)}
                    placeholder="Notes (e.g., Opening Day)"
                    disabled={disabled || day.closed}
                    className="flex-1"
                    maxLength={200}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
