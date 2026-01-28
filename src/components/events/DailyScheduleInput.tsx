"use client";

import { useState, useEffect, useCallback } from "react";
import { Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const startDate = new Date(start + "T12:00:00");
  const endDate = new Date(end + "T12:00:00");

  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
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

  // Generate days when dates change or feature is enabled
  useEffect(() => {
    if (!enabled || !startDate || !endDate) {
      return;
    }

    // Parse dates from startDate/endDate (they might be datetime strings or date strings)
    const startStr = startDate.includes("T") ? startDate.split("T")[0] : startDate;
    const endStr = endDate.includes("T") ? endDate.split("T")[0] : endDate;
    const dates = getDatesInRange(startStr, endStr);

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

  // Notify parent of changes
  useEffect(() => {
    if (enabled) {
      onChange(days);
    } else {
      onChange([]);
    }
  }, [enabled, days, onChange]);

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

  // Can only enable for multi-day events
  const isMultiDay =
    startDate &&
    endDate &&
    new Date(startDate).toDateString() !== new Date(endDate).toDateString();

  if (!isMultiDay) {
    return null;
  }

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
