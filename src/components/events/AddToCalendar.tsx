"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  generateGoogleCalendarUrl,
  generateOutlookCalendarUrl,
  generateICSDataUrl,
  generateMultiDayICSDataUrl,
} from "@/lib/utils";

interface EventDay {
  id?: string;
  date: string;
  openTime: string;
  closeTime: string;
  notes?: string | null;
  closed?: boolean;
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
  eventDays?: EventDay[];
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
  eventDays = [],
}: AddToCalendarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter to open days only
  const openDays = eventDays.filter((d) => !d.closed);
  const hasMultiDaySchedule = openDays.length > 0;

  // For Google/Outlook, use the first day's hours if we have per-day schedule
  const effectiveStartDate = hasMultiDaySchedule && openDays[0]
    ? new Date(`${openDays[0].date}T${openDays[0].openTime}:00`)
    : startDate ? new Date(startDate) : new Date();

  const effectiveEndDate = hasMultiDaySchedule && openDays[openDays.length - 1]
    ? new Date(`${openDays[openDays.length - 1].date}T${openDays[openDays.length - 1].closeTime}:00`)
    : endDate ? new Date(endDate) : new Date();

  const eventParams = {
    title,
    description,
    location,
    startDate: effectiveStartDate,
    endDate: effectiveEndDate,
    url,
  };

  const googleUrl = generateGoogleCalendarUrl(eventParams);
  const outlookUrl = generateOutlookCalendarUrl(eventParams);

  // Use multi-day ICS if we have per-day schedules, otherwise use standard ICS
  const icsUrl = hasMultiDaySchedule
    ? generateMultiDayICSDataUrl({
        title,
        description,
        location,
        url,
        eventDays: openDays,
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
      download: `${title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.ics`,
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
      ),
    },
  ];

  if (variant === "icon") {
    return (
      <div className={`relative inline-block ${className}`} ref={dropdownRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          className="p-1 text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
          aria-label="Add to calendar"
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          <Calendar className="w-4 h-4" aria-hidden="true" />
        </button>

        {isOpen && (
          <div className="absolute right-0 mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
            {calendarOptions.map((option) => (
              <a
                key={option.name}
                href={option.href}
                target="_blank"
                rel="noopener noreferrer"
                download={option.download}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setIsOpen(false)}
              >
                {option.icon}
                <span className="flex-1">{option.name}</span>
                {option.note && (
                  <span className="text-xs text-gray-400">{option.note}</span>
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
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
          aria-label="Add to calendar"
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          <Calendar className="w-4 h-4" aria-hidden="true" />
          Add to Calendar
          <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>

        {isOpen && (
          <div className="absolute left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
            {calendarOptions.map((option) => (
              <a
                key={option.name}
                href={option.href}
                target="_blank"
                rel="noopener noreferrer"
                download={option.download}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                onClick={() => setIsOpen(false)}
              >
                {option.icon}
                <span className="flex-1">{option.name}</span>
                {option.note && (
                  <span className="text-xs text-gray-400">{option.note}</span>
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
        <ChevronDown className={`w-4 h-4 ml-2 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
      </Button>

      {isOpen && (
        <div className="absolute left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
          {calendarOptions.map((option) => (
            <a
              key={option.name}
              href={option.href}
              target="_blank"
              rel="noopener noreferrer"
              download={option.download}
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              onClick={() => setIsOpen(false)}
            >
              {option.icon}
              <span className="flex-1">{option.name}</span>
              {option.note && (
                <span className="text-xs text-gray-400">{option.note}</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
