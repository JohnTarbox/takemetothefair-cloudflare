// Tier-1 FAQ data builder for event detail pages. Pure function — no DB,
// no React. Owns the question generation rules from MMATF-FAQ-Strategy.md
// §3.1 (vendor-side) and §3.2 (attendee-side), plus the suppression rules
// from §3.5 (omit individual questions when data is missing).
//
// HARD RULE (§8): FAQ JSON-LD must match visible content verbatim. The
// callers (`EventFAQSection` for HTML, `FAQPageSchema` for JSON-LD) MUST
// share the array returned by `buildEventFaqItems` so the two surfaces
// can never diverge.

import { formatDateOnly, formatDateRange, parseDateOnly } from "@/lib/datetime";
import { formatPrice } from "@/lib/utils";

export type FaqItem = { question: string; answer: string };

// Subset of the columns we read. Kept structural so tests can pass plain
// objects without instantiating the full Drizzle row type.
export type FaqEvent = {
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  applicationDeadline: Date | null;
  applicationUrl: string | null;
  applicationInstructions: string | null;
  vendorFeeMinCents: number | null;
  vendorFeeMaxCents: number | null;
  walkInsAllowed: boolean | null;
  estimatedAttendance: number | null;
  ticketPriceMinCents: number | null;
  ticketPriceMaxCents: number | null;
  ticketUrl: string | null;
  indoorOutdoor: string | null;
};

export type FaqVenue = {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
} | null;

export type FaqEventDay = {
  date: string;
  openTime: string;
  closeTime: string;
  closed: boolean | null;
  vendorOnly: boolean | null;
};

export type EventFaqInput = {
  event: FaqEvent;
  venue: FaqVenue;
  eventDays: FaqEventDay[];
  /** Override "now" for tests; defaults to Date.now(). */
  now?: Date;
};

const MAX_ITEMS = 10;
export const FAQ_MIN_ITEMS = 3;

function formatTime12(time24: string | null | undefined): string | null {
  if (!time24) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time24);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return minutes === 0
    ? `${hour12} ${period}`
    : `${hour12}:${minutes.toString().padStart(2, "0")} ${period}`;
}

function endWithDot(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

export function buildEventFaqItems(input: EventFaqInput): FaqItem[] {
  const { event, venue, eventDays } = input;
  const now = input.now ?? new Date();
  const items: FaqItem[] = [];

  // Vendor-side (primary audience per §3.1)

  if (event.applicationDeadline) {
    const dl = event.applicationDeadline;
    if (!isNaN(dl.getTime()) && dl >= now) {
      items.push({
        question: "When is the application deadline?",
        answer: `The vendor application deadline is ${formatDateOnly(dl)}.`,
      });
    }
  }

  if (event.applicationUrl || event.applicationInstructions) {
    const parts: string[] = [];
    if (event.applicationInstructions) parts.push(event.applicationInstructions.trim());
    if (event.applicationUrl) parts.push(`Apply online at ${event.applicationUrl}`);
    items.push({
      question: "How can I apply as a vendor?",
      answer: endWithDot(parts.join(". ")),
    });
  }

  if (event.vendorFeeMinCents !== null || event.vendorFeeMaxCents !== null) {
    const price = formatPrice(event.vendorFeeMinCents, event.vendorFeeMaxCents);
    if (price !== "Price TBD") {
      items.push({
        question: "What's the booth fee?",
        answer: price === "Free" ? "There is no booth fee." : `Booth fees are ${price}.`,
      });
    }
  }

  // §3.1 lists "Are commercial vendors allowed?" but the column defaults to
  // true, so we cannot distinguish "explicitly true" from "unset (default)".
  // Per §8 ("templates suppress, never lie") we skip this question entirely
  // until the field has explicit-null semantics.

  if (event.walkInsAllowed === true) {
    items.push({
      question: "Are walk-in vendors accepted?",
      answer: "Yes, walk-in vendors may be accepted day-of.",
    });
  } else if (event.walkInsAllowed === false) {
    items.push({
      question: "Are walk-in vendors accepted?",
      answer: "No, vendors must apply in advance.",
    });
  }

  if (event.estimatedAttendance && event.estimatedAttendance > 0) {
    items.push({
      question: "Approximately how many attendees does this event draw?",
      answer: `Approximately ${event.estimatedAttendance.toLocaleString("en-US")} attendees.`,
    });
  }

  const vendorOnlyDays = eventDays.filter((d) => d.vendorOnly === true);
  if (vendorOnlyDays.length > 0) {
    const dates = vendorOnlyDays
      .map((d) => formatDateOnly(parseDateOnly(d.date)))
      .filter((s) => s.length > 0)
      .join(", ");
    if (dates) {
      items.push({
        question: "Are there setup/load-in days?",
        answer:
          vendorOnlyDays.length === 1
            ? `Yes, vendors have a setup day on ${dates}.`
            : `Yes, vendors have setup days on ${dates}.`,
      });
    }
  }

  // Attendee-side (secondary audience per §3.2)

  if (event.startDate) {
    items.push({
      question: `When is ${event.name}?`,
      answer: `${event.name} runs ${formatDateRange(event.startDate, event.endDate)}.`,
    });
  }

  if (venue) {
    const parts: string[] = [venue.name];
    if (venue.address) parts.push(venue.address);
    if (venue.city && venue.state) parts.push(`${venue.city}, ${venue.state}`);
    items.push({
      question: "Where is it held?",
      answer: endWithDot(parts.join(", ")),
    });
  }

  // Hours: only render when public days share hours. A vague "varies" answer
  // doesn't help the FAQ; the daily schedule component handles per-day.
  const publicDays = eventDays.filter((d) => d.vendorOnly !== true && d.closed !== true);
  if (publicDays.length > 0) {
    const first = publicDays[0];
    const allSame = publicDays.every(
      (d) => d.openTime === first.openTime && d.closeTime === first.closeTime
    );
    if (allSame) {
      const open = formatTime12(first.openTime);
      const close = formatTime12(first.closeTime);
      if (open && close) {
        items.push({
          question: "What time does it run?",
          answer: `Open daily from ${open} to ${close}.`,
        });
      }
    }
  }

  if (event.ticketPriceMinCents !== null || event.ticketPriceMaxCents !== null) {
    const price = formatPrice(event.ticketPriceMinCents, event.ticketPriceMaxCents);
    if (price !== "Price TBD") {
      items.push({
        question: "How much is admission?",
        answer: price === "Free" ? "Admission is free." : `Admission is ${price}.`,
      });
    }
  }

  if (event.ticketUrl) {
    items.push({
      question: "Where can I buy tickets?",
      answer: `Tickets are available at ${event.ticketUrl}.`,
    });
  }

  if (event.indoorOutdoor) {
    const labels: Record<string, string> = {
      INDOOR: "This is an indoor event.",
      OUTDOOR: "This is an outdoor event.",
      MIXED: "This event has both indoor and outdoor portions.",
    };
    const label = labels[event.indoorOutdoor];
    if (label) {
      items.push({
        question: "Is this event indoor or outdoor?",
        answer: label,
      });
    }
  }

  // §3.2 lists a "rain policy" question for OUTDOOR/MIXED events, but no
  // rainPolicy field exists. Skip rather than fabricate a generic answer.

  return items.slice(0, MAX_ITEMS);
}
