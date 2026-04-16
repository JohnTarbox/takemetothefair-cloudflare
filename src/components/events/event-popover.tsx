"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { Calendar as CalendarIcon, MapPin, X, ChevronRight } from "lucide-react";
import { AddToCalendar } from "./AddToCalendar";
import { formatDateRange } from "@/lib/utils";
import { getCategoryBadgeClass, getCategoryImage } from "@/lib/category-colors";
import { parseJsonArray } from "@/types";
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

export type PopoverEvent = Event & {
  venue: Venue | null;
  promoter: Promoter | null;
  vendors?: VendorSummary[];
  eventDayDates?: string[];
};

// --- Positioning helper ---

function computePopoverPosition(
  anchor: { x: number; y: number },
  popoverSize: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8
): { top: number; left: number } {
  let top = anchor.y + gap;
  let left = anchor.x - popoverSize.width / 2;

  // Flip above if overflows bottom
  if (top + popoverSize.height > viewport.height - gap) {
    top = anchor.y - popoverSize.height - gap;
  }
  // Clamp top
  if (top < gap) top = gap;
  // Shift left if overflows right
  if (left + popoverSize.width > viewport.width - gap) {
    left = viewport.width - popoverSize.width - gap;
  }
  // Clamp to left edge
  if (left < gap) left = gap;

  return { top, left };
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

// --- Event Popover ---

interface EventPopoverProps {
  event: PopoverEvent;
  anchor: { x: number; y: number };
  onClose: () => void;
  getEventColor: (eventId: string) => string;
}

export function EventPopover({ event, anchor, onClose, getEventColor }: EventPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const isMobile = useIsMobile();

  // Position after first render (measure popover size)
  useEffect(() => {
    if (isMobile || !popoverRef.current) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const pos = computePopoverPosition(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    setPosition(pos);
  }, [anchor, isMobile]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const categories = parseJsonArray(event.categories);
  const imageUrl = event.imageUrl || getCategoryImage(categories);
  const location = event.venue
    ? `${event.venue.name}, ${event.venue.city}${event.venue.state ? `, ${event.venue.state}` : ""}`
    : null;

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 print:hidden" onClick={onClose}>
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/40" />
        {/* Bottom sheet */}
        <div
          ref={popoverRef}
          className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-2xl max-h-[70vh] overflow-y-auto animate-slide-up"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1">
            <div className="w-10 h-1 bg-gray-300 rounded-full" />
          </div>
          <PopoverContent
            event={event}
            imageUrl={imageUrl}
            categories={categories}
            location={location}
            getEventColor={getEventColor}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 print:hidden" onClick={onClose}>
      <div
        ref={popoverRef}
        className="absolute bg-white rounded-xl shadow-2xl border border-gray-200 w-80 overflow-hidden"
        style={
          position
            ? { top: position.top, left: position.left }
            : { visibility: "hidden", top: 0, left: 0 }
        }
        onClick={(e) => e.stopPropagation()}
      >
        <PopoverContent
          event={event}
          imageUrl={imageUrl}
          categories={categories}
          location={location}
          getEventColor={getEventColor}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function PopoverContent({
  event,
  imageUrl,
  categories,
  location,
  getEventColor,
  onClose,
}: {
  event: PopoverEvent;
  imageUrl: string;
  categories: string[];
  location: string | null;
  getEventColor: (eventId: string) => string;
  onClose: () => void;
}) {
  return (
    <div>
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-2 right-2 z-10 p-1 bg-white/80 backdrop-blur-sm rounded-full text-gray-500 hover:text-gray-800 hover:bg-white transition-colors"
        aria-label="Close"
      >
        <X className="w-4 h-4" />
      </button>

      {/* Image */}
      <div className="relative h-36 w-full bg-gray-100">
        <Image src={imageUrl} alt={event.name} fill sizes="320px" className="object-cover" />
        {/* Color bar */}
        <div className={`absolute bottom-0 left-0 right-0 h-1 ${getEventColor(event.id)}`} />
      </div>

      {/* Content */}
      <div className="p-4">
        <h3 className="font-semibold text-gray-900 text-base leading-tight mb-2">{event.name}</h3>

        <div className="space-y-1.5 text-sm text-gray-600 mb-3">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 flex-shrink-0 text-gray-400" />
            <span>{formatDateRange(event.startDate, event.endDate)}</span>
          </div>
          {location && (
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 flex-shrink-0 text-gray-400" />
              <span>{location}</span>
            </div>
          )}
        </div>

        {/* Category badges */}
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {categories.slice(0, 3).map((cat) => (
              <span
                key={cat}
                className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${getCategoryBadgeClass(cat)}`}
              >
                {cat}
              </span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <AddToCalendar
            title={event.name}
            description={event.description || undefined}
            location={location || undefined}
            startDate={event.startDate}
            endDate={event.endDate}
            url={`https://meetmeatthefair.com/events/${event.slug}`}
            variant="icon"
          />
          <Link
            href={`/events/${event.slug}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-royal text-white text-sm font-medium rounded-lg hover:bg-navy transition-colors"
          >
            View Details
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// --- Day Events Popover ---

interface DayEventsPopoverProps {
  date: Date;
  events: PopoverEvent[];
  anchor: { x: number; y: number };
  onClose: () => void;
  onEventClick: (event: PopoverEvent, anchor: { x: number; y: number }) => void;
  onViewDay: (date: Date) => void;
  getEventColor: (eventId: string) => string;
}

export function DayEventsPopover({
  date,
  events: dayEvents,
  anchor,
  onClose,
  onEventClick,
  onViewDay,
  getEventColor,
}: DayEventsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const isMobile = useIsMobile();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isMobile || !popoverRef.current) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const pos = computePopoverPosition(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    setPosition(pos);
  }, [anchor, isMobile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Arrow key navigation within the list
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const focusable = listRef.current?.querySelectorAll<HTMLElement>("button[data-event-row]");
      if (!focusable?.length) return;
      const items = Array.from(focusable);
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
      next?.focus();
    }
  }, []);

  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const content = (
    <div onKeyDown={handleKeyDown}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="font-semibold text-gray-900 text-sm">{dateLabel}</h3>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Event list */}
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {dayEvents.map((event) => (
          <button
            key={event.id}
            data-event-row
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onEventClick(event, { x: rect.right, y: rect.top });
            }}
            className="w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center gap-2.5 transition-colors focus:bg-gray-50 focus:outline-none"
          >
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getEventColor(event.id)}`} />
            <span className="text-sm text-gray-800 truncate flex-1">{event.name}</span>
            <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          </button>
        ))}
      </div>

      {/* View day link */}
      <div className="border-t border-gray-100 px-4 py-2">
        <button
          onClick={() => {
            onViewDay(date);
            onClose();
          }}
          className="text-sm text-royal hover:text-navy font-medium transition-colors"
        >
          View full day
        </button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 print:hidden" onClick={onClose}>
        <div className="absolute inset-0 bg-black/40" />
        <div
          ref={popoverRef}
          className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-2xl max-h-[70vh] overflow-y-auto animate-slide-up"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-center pt-3 pb-1">
            <div className="w-10 h-1 bg-gray-300 rounded-full" />
          </div>
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 print:hidden" onClick={onClose}>
      <div
        ref={popoverRef}
        className="absolute bg-white rounded-xl shadow-2xl border border-gray-200 w-72 overflow-hidden"
        style={
          position
            ? { top: position.top, left: position.left }
            : { visibility: "hidden", top: 0, left: 0 }
        }
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>
  );
}
