"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { trackAddToCalendar } from "@/lib/analytics";

// U7 / Phase D (2026-06-02) — the icon variant's trigger moved from a
// raw <button> with `p-3.5 -m-1` (~44px hit area but loosely enforced,
// negative margin pulled visual padding back to ~36px) to the shared
// IconButton primitive so the floor is type-enforced and matches the
// FavoriteButton / ShareButtons pair. Dropdown menu items get an
// explicit min-h-[40px] across all three variants for the same
// reason — WCAG 2.2 AA 2.5.8.
import {
  generateGoogleCalendarUrl,
  generateOutlookCalendarUrl,
  generateICSDataUrl,
  generateMultiDayICSDataUrl,
} from "@/lib/utils";

interface EventDay {
  id?: string;
  date: string;
  // DQ4 (drizzle/0118, 2026-06-08): openTime/closeTime are nullable.
  // The Google/Outlook URL + ICS code below now falls back to the
  // event-level startDate/endDate when per-day hours aren't captured —
  // an "Add to Calendar" surface with literal "null" times would land
  // an invalid event on the user's calendar.
  openTime: string | null;
  closeTime: string | null;
  notes?: string | null;
  closed?: boolean | null;
  // Allow vendorOnly because the DB schema includes it (vendor-only days
  // are excluded from public ICS output by generateMultiDayICSContent).
  vendorOnly?: boolean | null;
  // Extra DB-row fields ignored by the calendar generator but tolerated
  // for assignability from the canonical EventDay row type.
  eventId?: string;
  createdAt?: Date | null;
}

interface AddToCalendarProps {
  title: string;
  description?: string;
  location?: string;
  startDate: Date | string | null;
  endDate: Date | string | null;
  url?: string;
  variant?: "button" | "link" | "icon";
  className?: string;
  // ENG1 audit (docs/eng1-audit.md §B.2, 2026-06-09) — the real event
  // slug, used as the `event_slug` GA4 custom-dimension param on the
  // add_to_calendar event. When omitted, the helper falls back to the
  // pre-existing title-derived slug (which conflates events with the
  // same title) — keep callers warning-free by passing event.slug
  // wherever it's in scope.
  eventSlug?: string;
  eventDays?: EventDay[];
  // Cohort 7 (C1/U1, 2026-06-01) — RFC 5545 RRULE for events whose
  // recurrence isn't captured by event_days. Forwarded to the
  // single-VEVENT ICS path so the user's calendar can expand
  // occurrences itself. Rare today (~1/942 events) — the common
  // recurring pattern uses event_days, which goes through the
  // generateMultiDayICSDataUrl path below and emits one VEVENT per
  // occurrence (no RRULE needed).
  recurrenceRule?: string | null;
  /** Venue's IANA timezone (P3b, 2026-06-06). Threaded into the
   *  multi-day ICS path so DTSTART/DTEND/VTIMEZONE all reference the
   *  venue's local clock. Omit (or pass undefined) at venues whose
   *  timezone is the project default America/New_York — the helper
   *  falls back to VENUE_TZ for backward compat. */
  venueTimezone?: string;
}

export function AddToCalendar({
  title,
  description,
  location,
  startDate,
  endDate,
  url,
  variant = "button",
  className = "",
  eventSlug,
  eventDays = [],
  recurrenceRule = null,
  venueTimezone,
}: AddToCalendarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // DQ4 (2026-06-08): filter to open days with known hours. A day with
  // null openTime/closeTime can't be put on the user's calendar without
  // fabricating times. Fall back to the event-level startDate/endDate
  // for those events (same as the no-eventDays branch below).
  const openDays = eventDays.filter((d) => !d.closed);
  const openDaysWithHours = openDays.filter(
    (d): d is EventDay & { openTime: string; closeTime: string } =>
      d.openTime != null && d.closeTime != null
  );
  const hasMultiDaySchedule = openDaysWithHours.length > 0;

  // For Google/Outlook, use the first day's hours if we have per-day schedule
  const effectiveStartDate =
    hasMultiDaySchedule && openDaysWithHours[0]
      ? new Date(`${openDaysWithHours[0].date}T${openDaysWithHours[0].openTime}:00`)
      : startDate
        ? new Date(startDate)
        : new Date();

  const effectiveEndDate =
    hasMultiDaySchedule && openDaysWithHours[openDaysWithHours.length - 1]
      ? new Date(
          `${openDaysWithHours[openDaysWithHours.length - 1].date}T${openDaysWithHours[openDaysWithHours.length - 1].closeTime}:00`
        )
      : endDate
        ? new Date(endDate)
        : new Date();

  const eventParams = {
    title,
    description,
    location,
    startDate: effectiveStartDate,
    endDate: effectiveEndDate,
    url,
    // Cohort 7 — forward only when no event_days path is active.
    // When eventDays drive the ICS, recurrenceRule would double up.
    recurrenceRule: hasMultiDaySchedule ? null : recurrenceRule,
  };

  const googleUrl = generateGoogleCalendarUrl(eventParams);
  const outlookUrl = generateOutlookCalendarUrl(eventParams);

  // Use multi-day ICS if we have per-day schedules with hours, otherwise
  // use standard ICS. DQ4 (2026-06-08): pass openDaysWithHours (filtered
  // to rows where both openTime and closeTime are known) so the ICS
  // generator never sees a null time — calendar import on the user's
  // device would silently drop or mis-render those entries.
  const icsUrl = hasMultiDaySchedule
    ? generateMultiDayICSDataUrl({
        title,
        description,
        location,
        url,
        eventDays: openDaysWithHours,
        venueTimezone,
      })
    : generateICSDataUrl(eventParams);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setIsOpen(false);
    }
  };

  // slugFromTitle still drives the .ics download filename below (kept
  // for backward compat — older saved .ics files use this shape). But
  // the analytics emit prefers the real eventSlug when available so
  // GA4's event_slug custom dim groups by URL slug, not title (see
  // docs/eng1-audit.md §B.2).
  const slugFromTitle = title.replace(/[^a-z0-9]/gi, "-").toLowerCase();

  const handleCalendarClick = (calendarType: string) => {
    trackAddToCalendar(eventSlug ?? slugFromTitle, calendarType);
    setIsOpen(false);
  };

  const calendarOptions = [
    {
      name: "Google Calendar",
      href: googleUrl,
      note: hasMultiDaySchedule ? "(first day only)" : undefined,
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.5 22h-15A2.5 2.5 0 0 1 2 19.5v-15A2.5 2.5 0 0 1 4.5 2h15A2.5 2.5 0 0 1 22 4.5v15a2.5 2.5 0 0 1-2.5 2.5zM9 17v-5H7v5h2zm4 0v-8h-2v8h2zm4 0V9h-2v8h2z" />
        </svg>
      ),
    },
    {
      name: "Outlook Calendar",
      href: outlookUrl,
      note: hasMultiDaySchedule ? "(first day only)" : undefined,
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8zm1-13h-2v6l5.25 3.15.75-1.23-4-2.42V7z" />
        </svg>
      ),
    },
    {
      name: hasMultiDaySchedule ? "Download .ics (all days)" : "Download .ics",
      href: icsUrl,
      download: `${slugFromTitle}.ics`,
      icon: (
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
      ),
    },
  ];

  if (variant === "icon") {
    return (
      <div className={`relative inline-block ${className}`} ref={dropdownRef}>
        <IconButton
          size="md"
          variant="ghost"
          aria-label="Add to calendar"
          aria-expanded={isOpen}
          aria-haspopup="true"
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          // Preserve the existing royal/navy hover treatment via
          // className override; twMerge collapses the base ghost
          // gray hover in favor of the brand-blue-light hover here.
          className="text-royal hover:text-navy hover:bg-brand-blue-light"
          icon={<Calendar className="w-5 h-5" />}
        />

        {isOpen && (
          <div className="absolute right-0 mt-1 w-56 bg-card rounded-lg shadow-lg border border-border py-1 z-50">
            {calendarOptions.map((option) => (
              <a
                key={option.name}
                href={option.href}
                target="_blank"
                rel="noopener noreferrer"
                download={option.download}
                className="flex items-center gap-2 min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted"
                onClick={() => handleCalendarClick(option.name)}
              >
                {option.icon}
                <span className="flex-1">{option.name}</span>
                {option.note && (
                  <span className="text-xs text-muted-foreground">{option.note}</span>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (variant === "link") {
    return (
      <div className={`relative inline-block ${className}`} ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          className="inline-flex items-center gap-1 text-sm text-royal hover:text-navy"
          aria-label="Add to calendar"
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          <Calendar className="w-4 h-4" aria-hidden="true" />
          Add to Calendar
          <ChevronDown
            className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>

        {isOpen && (
          <div className="absolute left-0 mt-1 w-56 bg-card rounded-lg shadow-lg border border-border py-1 z-50">
            {calendarOptions.map((option) => (
              <a
                key={option.name}
                href={option.href}
                target="_blank"
                rel="noopener noreferrer"
                download={option.download}
                className="flex items-center gap-2 min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted"
                onClick={() => handleCalendarClick(option.name)}
              >
                {option.icon}
                <span className="flex-1">{option.name}</span>
                {option.note && (
                  <span className="text-xs text-muted-foreground">{option.note}</span>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Default button variant
  return (
    <div className={`relative inline-block ${className}`} ref={dropdownRef}>
      <Button
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        variant="outline"
        className="w-full"
        aria-label="Add to calendar"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <Calendar className="w-4 h-4 mr-2" aria-hidden="true" />
        Add to Calendar
        <ChevronDown
          className={`w-4 h-4 ml-2 transition-transform ${isOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </Button>

      {isOpen && (
        <div className="absolute left-0 right-0 mt-1 bg-card rounded-lg shadow-lg border border-border py-1 z-50">
          {calendarOptions.map((option) => (
            <a
              key={option.name}
              href={option.href}
              target="_blank"
              rel="noopener noreferrer"
              download={option.download}
              className="flex items-center gap-2 min-h-[40px] px-4 py-2 text-sm text-foreground hover:bg-muted"
              onClick={() => setIsOpen(false)}
            >
              {option.icon}
              <span className="flex-1">{option.name}</span>
              {option.note && <span className="text-xs text-muted-foreground">{option.note}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
