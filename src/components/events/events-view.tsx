"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutGrid, Table, Calendar as CalendarIcon, MapPin, ExternalLink, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { EventCard } from "./event-card";
import { SortableHeader, SortConfig, sortData, getNextSortDirection } from "@/components/ui/sortable-table";
import { formatDateRange } from "@/lib/utils";
import type { events, venues, promoters } from "@/lib/db/schema";

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
  venue: Venue;
  promoter: Promoter;
  vendors?: VendorSummary[];
};

interface EventsViewProps {
  events: EventWithRelations[];
  emptyMessage?: string;
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
}

function CalendarView({ events }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedEvent, setSelectedEvent] = useState<EventWithRelations | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDayOfMonth = getFirstDayOfMonth(year, month);
  const today = new Date();

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  // Get events for a specific day
  const getEventsForDay = (day: number): EventWithRelations[] => {
    const date = new Date(year, month, day);
    return events.filter((event) => {
      const startDate = event.startDate ? new Date(event.startDate) : null;
      const endDate = event.endDate ? new Date(event.endDate) : startDate;
      return isDateInRange(date, startDate, endDate);
    });
  };

  // Build calendar grid
  const calendarDays: (number | null)[] = [];

  // Add empty cells for days before the first day of the month
  for (let i = 0; i < firstDayOfMonth; i++) {
    calendarDays.push(null);
  }

  // Add all days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(day);
  }

  // Fill remaining cells to complete the grid (6 rows x 7 days = 42 cells)
  while (calendarDays.length < 42) {
    calendarDays.push(null);
  }

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Calendar Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <button
            onClick={goToToday}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Today
          </button>
          <div className="flex items-center">
            <button
              onClick={prevMonth}
              className="p-1.5 text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={nextMonth}
              className="p-1.5 text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Next month"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
        <h2 className="text-lg font-semibold text-gray-900">
          {formatMonthYear(currentDate)}
        </h2>
        <div className="w-24" /> {/* Spacer for centering */}
      </div>

      {/* Week Day Headers */}
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
        {weekDays.map((day) => (
          <div
            key={day}
            className="py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7">
        {calendarDays.map((day, index) => {
          const isToday = day !== null && isSameDay(new Date(year, month, day), today);
          const dayEvents = day !== null ? getEventsForDay(day) : [];
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
                  {/* Day Number */}
                  <div className="flex justify-center mb-1">
                    <span
                      className={`inline-flex items-center justify-center w-7 h-7 text-sm ${
                        isToday
                          ? "bg-blue-600 text-white rounded-full font-semibold"
                          : "text-gray-700"
                      }`}
                    >
                      {day}
                    </span>
                  </div>

                  {/* Events */}
                  <div className="space-y-0.5">
                    {dayEvents.slice(0, 3).map((event) => (
                      <Link
                        key={event.id}
                        href={`/events/${event.slug}`}
                        className={`block px-1.5 py-0.5 text-xs text-white rounded truncate ${getEventColor(
                          event.id
                        )} hover:opacity-80 transition-opacity`}
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

      {/* Event Details Modal */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
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
      <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
        <p className="text-xs text-gray-500">
          Click on an event to view details. Events spanning multiple days appear on each day.
        </p>
      </div>
    </div>
  );
}

export function EventsView({
  events,
  emptyMessage = "No events found",
}: EventsViewProps) {
  const [viewMode, setViewMode] = useState<"cards" | "table" | "calendar">("cards");
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

  return (
    <div>
      {/* View Toggle and Download */}
      <div className="flex justify-end items-center gap-3 mb-4">
        {viewMode === "table" && (
          <button
            onClick={downloadCSV}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 border border-gray-200 bg-white transition-colors"
          >
            <Download className="w-4 h-4" />
            Download CSV
          </button>
        )}
        <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-white">
          <button
            onClick={() => setViewMode("cards")}
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
            onClick={() => setViewMode("table")}
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
            onClick={() => setViewMode("calendar")}
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
          {sortedEvents.map((event) => (
            <EventCard key={event.id} event={event} />
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
      {viewMode === "calendar" && <CalendarView events={events} />}
    </div>
  );
}
