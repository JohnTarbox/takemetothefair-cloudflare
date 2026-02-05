"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LayoutGrid, Table, Calendar as CalendarIcon, MapPin, ExternalLink, Download, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { EventCard } from "./event-card";
import { SortableHeader, SortConfig, sortData, getNextSortDirection } from "@/components/ui/sortable-table";
import { formatDateRange } from "@/lib/utils";
import type { events, venues, promoters } from "@/lib/db/schema";

type CalendarViewType = "day" | "week" | "month" | "year" | "schedule";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

type VendorSummary = {
  id: string;
  businessName: string;
  slug: string;
  logoUrl: string | null;
  vendorType: string | null;
};

type EventWithRelations = Event & {
  venue: Venue | null;
  promoter: Promoter | null;
  vendors?: VendorSummary[];
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
}

function getCalendarPeriodSummary(
  events: EventWithRelations[],
  viewType: CalendarViewType,
  currentDate: Date
): { count: number; label: string } {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  switch (viewType) {
    case "month": {
      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 0);
      const filtered = events.filter((e) => {
        const start = e.startDate ? new Date(e.startDate) : null;
        const end = e.endDate ? new Date(e.endDate) : start;
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
        const start = e.startDate ? new Date(e.startDate) : null;
        const end = e.endDate ? new Date(e.endDate) : start;
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
      const dayLabel = currentDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      return { count: filtered.length, label: `on ${dayLabel}` };
    }
    case "year": {
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31);
      const filtered = events.filter((e) => {
        const start = e.startDate ? new Date(e.startDate) : null;
        const end = e.endDate ? new Date(e.endDate) : start;
        if (!start) return false;
        return start <= yearEnd && (end || start) >= yearStart;
      });
      return { count: filtered.length, label: `in ${year}` };
    }
    case "schedule": {
      const viewStart = new Date(year, month, 1);
      const filtered = events.filter((e) => {
        const start = e.startDate ? new Date(e.startDate) : null;
        if (!start) return false;
        return start >= viewStart || (e.endDate && new Date(e.endDate) >= viewStart);
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

function isDateInRange(date: Date, startDate: Date | null, endDate: Date | null): boolean {
  if (!startDate) return false;
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const startOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const endOnly = endDate
    ? new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
    : startOnly;
  return dateOnly >= startOnly && dateOnly <= endOnly;
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Generate a consistent color for an event based on its ID
function getEventColor(eventId: string): string {
  const colors = [
    "bg-blue-500",
    "bg-green-500",
    "bg-purple-500",
    "bg-pink-500",
    "bg-indigo-500",
    "bg-teal-500",
    "bg-orange-500",
    "bg-cyan-500",
  ];
  let hash = 0;
  for (let i = 0; i < eventId.length; i++) {
    hash = eventId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

interface CalendarViewProps {
  events: EventWithRelations[];
  currentDate: Date;
  onDateChange: (date: Date) => void;
  calendarViewType: CalendarViewType;
  onViewTypeChange: (type: CalendarViewType) => void;
}

// Additional helper functions for calendar views
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function formatShortMonth(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short" });
}

function getEventsForDate(events: EventWithRelations[], date: Date): EventWithRelations[] {
  return events.filter((event) => {
    const startDate = event.startDate ? new Date(event.startDate) : null;
    const endDate = event.endDate ? new Date(event.endDate) : startDate;
    return isDateInRange(date, startDate, endDate);
  });
}

function CalendarView({ events, currentDate, onDateChange, calendarViewType, onViewTypeChange }: CalendarViewProps) {
  const setCurrentDate = onDateChange;
  const setCalendarViewType = onViewTypeChange;
  const [selectedEvent, setSelectedEvent] = useState<EventWithRelations | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const today = new Date();

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
    const dayEvents = getEventsForDate(events, currentDate);

    return (
      <div className="border-t border-gray-200">
        <div className="text-center py-2 border-b border-gray-200 bg-gray-50">
          <div className="text-sm text-gray-500">{currentDate.toLocaleDateString("en-US", { weekday: "long" })}</div>
          <div className={`text-2xl font-semibold ${isSameDay(currentDate, today) ? "text-blue-600" : "text-gray-900"}`}>
            {currentDate.getDate()}
          </div>
        </div>
        <div className="max-h-[600px] overflow-y-auto print:max-h-none print:overflow-visible">
          {dayEvents.length === 0 ? (
            <div className="py-12 text-center text-gray-500">No events scheduled for this day</div>
          ) : (
            <div className="divide-y divide-gray-200">
              {dayEvents.map((event) => (
                <Link
                  key={event.id}
                  href={`/events/${event.slug}`}
                  className="block p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-1 h-full min-h-[40px] rounded ${getEventColor(event.id)}`} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900">{event.name}</div>
                      <div className="text-sm text-gray-500 mt-1">
                        {formatDateRange(event.startDate, event.endDate)}
                      </div>
                      {event.venue && (
                        <div className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                          <MapPin className="w-3 h-3" />
                          {event.venue.name}, {event.venue.city}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
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
        <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
          {days.map((day, i) => (
            <div key={i} className="py-2 text-center border-r border-gray-200 last:border-r-0">
              <div className="text-xs text-gray-500 uppercase">{weekDays[i]}</div>
              <div className={`text-lg font-semibold ${isSameDay(day, today) ? "bg-blue-600 text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto" : "text-gray-900"}`}>
                {day.getDate()}
              </div>
            </div>
          ))}
        </div>
        {/* Week grid */}
        <div className="grid grid-cols-7 min-h-[400px]">
          {days.map((day, i) => {
            const dayEvents = getEventsForDate(events, day);
            return (
              <div key={i} className="border-r border-gray-200 last:border-r-0 p-1">
                <div className="space-y-1">
                  {dayEvents.slice(0, 5).map((event) => (
                    <Link
                      key={event.id}
                      href={`/events/${event.slug}`}
                      className={`block px-1.5 py-1 text-xs text-white rounded truncate ${getEventColor(event.id)} hover:opacity-80 transition-opacity`}
                      title={event.name}
                    >
                      {event.name}
                    </Link>
                  ))}
                  {dayEvents.length > 5 && (
                    <div className="text-xs text-gray-500 px-1.5">+{dayEvents.length - 5} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render Month View
  const renderMonthView = () => {
    const daysInMonth = getDaysInMonth(year, month);
    const firstDayOfMonth = getFirstDayOfMonth(year, month);

    const calendarDays: (number | null)[] = [];
    for (let i = 0; i < firstDayOfMonth; i++) {
      calendarDays.push(null);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      calendarDays.push(day);
    }
    while (calendarDays.length < 42) {
      calendarDays.push(null);
    }

    return (
      <div>
        {/* Week Day Headers */}
        <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
          {weekDays.map((day) => (
            <div key={day} className="py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              {day}
            </div>
          ))}
        </div>
        {/* Calendar Grid */}
        <div className="grid grid-cols-7">
          {calendarDays.map((day, index) => {
            const isToday = day !== null && isSameDay(new Date(year, month, day), today);
            const dayEvents = day !== null ? getEventsForDate(events, new Date(year, month, day)) : [];
            const isCurrentMonth = day !== null;

            return (
              <div
                key={index}
                className={`min-h-[100px] border-b border-r border-gray-200 ${
                  index % 7 === 0 ? "border-l-0" : ""
                } ${!isCurrentMonth ? "bg-gray-50" : "bg-white"}`}
              >
                {day !== null && (
                  <div className="p-1">
                    <div className="flex justify-center mb-1">
                      <span
                        className={`inline-flex items-center justify-center w-7 h-7 text-sm ${
                          isToday ? "bg-blue-600 text-white rounded-full font-semibold" : "text-gray-700"
                        }`}
                      >
                        {day}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 3).map((event) => (
                        <Link
                          key={event.id}
                          href={`/events/${event.slug}`}
                          className={`block px-1.5 py-0.5 text-xs text-white rounded truncate ${getEventColor(event.id)} hover:opacity-80 transition-opacity`}
                          title={event.name}
                        >
                          {event.name}
                        </Link>
                      ))}
                      {dayEvents.length > 3 && (
                        <button
                          onClick={() => setSelectedEvent(dayEvents[0])}
                          className="block w-full text-left px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100 rounded"
                        >
                          +{dayEvents.length - 3} more
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

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
            const startDate = event.startDate ? new Date(event.startDate) : null;
            const endDate = event.endDate ? new Date(event.endDate) : startDate;
            if (!startDate) return false;
            const monthStart = new Date(year, monthIndex, 1);
            const monthEnd = new Date(year, monthIndex + 1, 0);
            return (startDate <= monthEnd && (endDate || startDate) >= monthStart);
          });

          const miniDays: (number | null)[] = [];
          for (let i = 0; i < firstDay; i++) miniDays.push(null);
          for (let d = 1; d <= daysInMonth; d++) miniDays.push(d);

          return (
            <div
              key={monthIndex}
              className="bg-white border border-gray-200 rounded-lg overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => {
                setCurrentDate(new Date(year, monthIndex, 1));
                setCalendarViewType("month");
              }}
            >
              <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
                <div className="text-sm font-medium text-gray-900">
                  {monthDate.toLocaleDateString("en-US", { month: "long" })}
                </div>
                {monthEvents.length > 0 && (
                  <div className="text-xs text-blue-600">{monthEvents.length} event{monthEvents.length !== 1 ? "s" : ""}</div>
                )}
              </div>
              <div className="p-2">
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <div key={i} className="text-[10px] text-gray-400 font-medium">{d}</div>
                  ))}
                  {miniDays.slice(0, 42).map((day, i) => {
                    const hasEvent = day !== null && getEventsForDate(events, new Date(year, monthIndex, day)).length > 0;
                    const isCurrentDay = day !== null && isSameDay(new Date(year, monthIndex, day), today);
                    return (
                      <div
                        key={i}
                        className={`text-[10px] w-5 h-5 flex items-center justify-center rounded-full ${
                          isCurrentDay ? "bg-blue-600 text-white" : hasEvent ? "bg-blue-100 text-blue-700" : "text-gray-700"
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
        const startDate = event.startDate ? new Date(event.startDate) : null;
        if (!startDate) return false;
        const viewStart = new Date(year, month, 1);
        return startDate >= viewStart || (event.endDate && new Date(event.endDate) >= viewStart);
      })
      .sort((a, b) => {
        const aDate = a.startDate ? new Date(a.startDate).getTime() : Infinity;
        const bDate = b.startDate ? new Date(b.startDate).getTime() : Infinity;
        return aDate - bDate;
      });

    // Group events by date
    const groupedEvents: { [key: string]: EventWithRelations[] } = {};
    scheduleEvents.forEach((event) => {
      if (event.startDate) {
        const dateKey = new Date(event.startDate).toDateString();
        if (!groupedEvents[dateKey]) {
          groupedEvents[dateKey] = [];
        }
        groupedEvents[dateKey].push(event);
      }
    });

    const sortedDates = Object.keys(groupedEvents).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

    return (
      <div className="max-h-[600px] overflow-y-auto print:max-h-none print:overflow-visible">
        {sortedDates.length === 0 ? (
          <div className="py-12 text-center text-gray-500">No upcoming events</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {sortedDates.map((dateKey) => {
              const date = new Date(dateKey);
              const isCurrentDay = isSameDay(date, today);
              return (
                <div key={dateKey}>
                  <div className={`sticky top-0 px-4 py-2 bg-gray-50 border-b border-gray-100 ${isCurrentDay ? "bg-blue-50" : ""}`}>
                    <div className="flex items-center gap-3">
                      <div className={`text-2xl font-bold ${isCurrentDay ? "text-blue-600" : "text-gray-900"}`}>
                        {date.getDate()}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${isCurrentDay ? "text-blue-600" : "text-gray-900"}`}>
                          {date.toLocaleDateString("en-US", { weekday: "long" })}
                        </div>
                        <div className="text-xs text-gray-500">
                          {date.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {groupedEvents[dateKey].map((event) => (
                      <Link
                        key={event.id}
                        href={`/events/${event.slug}`}
                        className="block px-4 py-3 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-1 h-full min-h-[40px] rounded ${getEventColor(event.id)}`} />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900">{event.name}</div>
                            <div className="text-sm text-gray-500 mt-1">
                              {formatDateRange(event.startDate, event.endDate)}
                            </div>
                            {event.venue && (
                              <div className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                                <MapPin className="w-3 h-3" />
                                {event.venue.name}, {event.venue.city}, {event.venue.state}
                              </div>
                            )}
                          </div>
                        </div>
                      </Link>
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
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden print:border-0">
      {/* Print-only title */}
      <div className="hidden print:block px-4 py-3 border-b border-gray-200">
        <h1 className="text-xl font-bold text-gray-900">Events Calendar — {getTitle()}</h1>
      </div>
      {/* Calendar Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 print:hidden">
        <div className="flex items-center gap-2">
          <button
            onClick={goToToday}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Today
          </button>
          <div className="flex items-center">
            <button
              onClick={() => navigate("prev")}
              className="p-1.5 text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => navigate("next")}
              className="p-1.5 text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 ml-2">
            {getTitle()}
          </h2>
        </div>

        {/* View Type Selector */}
        <div className="flex items-center gap-1 bg-white border border-gray-300 rounded-lg p-0.5">
          {viewOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setCalendarViewType(option.value)}
              className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                calendarViewType === option.value
                  ? "bg-blue-600 text-white"
                  : "text-gray-600 hover:bg-gray-100"
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

      {/* Event Details Modal */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSelectedEvent(null)}
          />
          <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <button
              onClick={() => setSelectedEvent(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
            >
              ×
            </button>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {selectedEvent.name}
            </h3>
            <div className="space-y-2 text-sm text-gray-600">
              <div className="flex items-center gap-2">
                <CalendarIcon className="w-4 h-4" />
                {formatDateRange(selectedEvent.startDate, selectedEvent.endDate)}
              </div>
              {selectedEvent.venue && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  {selectedEvent.venue.name}, {selectedEvent.venue.city}, {selectedEvent.venue.state}
                </div>
              )}
            </div>
            <div className="mt-4">
              <Link
                href={`/events/${selectedEvent.slug}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                View Event Details
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 print:hidden">
        <p className="text-xs text-gray-500">
          {calendarViewType === "year"
            ? "Click on a month to view details. Highlighted days have events."
            : "Click on an event to view details. Events spanning multiple days appear on each day."}
        </p>
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
}: EventsViewProps) {
  const currentSearchParams = useSearchParams();
  const viewMode = view;
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [calendarViewType, setCalendarViewType] = useState<CalendarViewType>("month");

  const switchView = (newView: string) => {
    const params = new URLSearchParams(currentSearchParams.toString());
    params.set("view", newView);
    params.delete("page");
    window.location.href = `/events?${params.toString()}`;
  };

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

  const sortedEvents = sortData(events, sortConfig, {
    name: (e) => e.name.toLowerCase(),
    venue: (e) => e.venue?.name?.toLowerCase() || "",
    city: (e) => e.venue?.city?.toLowerCase() || "",
    state: (e) => e.venue?.state || "",
    // Put null dates at the end by using Infinity for asc sort
    startDate: (e) => e.startDate ? new Date(e.startDate).getTime() : Infinity,
    endDate: (e) => e.endDate ? new Date(e.endDate).getTime() : Infinity,
  });

  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    );
  }

  const summaryText = (() => {
    const suffix = myEvents ? " you're participating in" : "";
    if (viewMode === "calendar") {
      const { count, label } = getCalendarPeriodSummary(events, calendarViewType, calendarDate);
      if (calendarViewType === "schedule") {
        return `Showing all ${count} event${count !== 1 ? "s" : ""}${suffix} ${label}`;
      }
      return `Showing ${count} event${count !== 1 ? "s" : ""}${suffix} ${label}`;
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
        <p className="text-sm text-gray-600 mb-4 print:hidden">{summaryText}</p>
      )}

      {/* View Toggle and Download */}
      <div className="flex justify-end items-center gap-3 mb-4 print:hidden">
        {viewMode === "table" && (
          <button
            onClick={downloadCSV}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 border border-gray-200 bg-white transition-colors"
          >
            <Download className="w-4 h-4" />
            Download CSV
          </button>
        )}
        {viewMode === "calendar" && (
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 border border-gray-200 bg-white transition-colors"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
        )}
        <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-white">
          <button
            onClick={() => switchView("cards")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "cards"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Cards
          </button>
          <button
            onClick={() => switchView("table")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "table"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <Table className="w-4 h-4" />
            Table
          </button>
          <button
            onClick={() => switchView("calendar")}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "calendar"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
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
          {sortedEvents.map((event, index) => (
            <EventCard key={event.id} event={event} priority={index < 3} />
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === "table" && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
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
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-600 w-24">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedEvents.map((event) => (
                  <tr key={event.id} className="hover:bg-gray-50">
                    <td className="py-3 px-4">
                      <Link
                        href={`/events/${event.slug}`}
                        className="font-medium text-gray-900 hover:text-blue-600"
                      >
                        {event.name}
                      </Link>
                      {event.featured && (
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                          Featured
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {event.venue?.name || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {event.venue?.city || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">
                      {event.venue?.state || "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <CalendarIcon className="w-4 h-4 text-gray-400" />
                        {formatDateRange(event.startDate, event.endDate)}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/events/${event.slug}`}
                          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                        >
                          View
                        </Link>
                        {event.ticketUrl && (
                          <a
                            href={event.ticketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-400 hover:text-gray-600"
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
        />
      )}

      {/* Pagination - only shown for cards/table views, not calendar */}
      {viewMode !== "calendar" && totalPages > 1 && (
        <div className="mt-8 flex justify-center gap-2">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <a
              key={p}
              href={`/events?${new URLSearchParams({
                ...searchParams,
                page: p.toString(),
              }).toString()}`}
              className={`px-4 py-2 rounded-lg ${
                p === currentPage
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {p}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
