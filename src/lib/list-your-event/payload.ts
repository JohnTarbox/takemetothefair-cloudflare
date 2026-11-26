/**
 * OPE-1558 — the one-screen, no-login "List your fair free" form.
 *
 * This module is the form's whole contract with the server, kept pure so it can
 * be tested without a browser: what the organizer typed in → the body
 * `/api/suggest-event/submit` already accepts. There is deliberately NO new
 * write path. The existing route already does everything an anonymous intake
 * needs — Turnstile + per-IP rate limit, the OPE-411 unusable-name refusal,
 * server-side venue auto-link / minting from name + town + state, the
 * submission-received receipt, and PENDING-until-reviewed status. A second
 * writer would be a second copy of all of that, and the codebase's recurring
 * defect is a fix that reaches one of two parallel paths.
 *
 * What it adds over the URL-first `/suggest-event` wizard is only the SHAPE:
 * no URL step, no AI extraction, every field visible on one screen. That is the
 * friction craftfairlist doesn't have and we did.
 */

import { STATES, isStateCode } from "@/lib/states";

export interface ListYourEventInput {
  name: string;
  startDate: string; // YYYY-MM-DD from <input type="date">
  endDate: string; // optional; "" when single-day
  town: string;
  state: string; // two-letter code
  venueName: string; // optional
  category: string; // optional; one EVENT_CATEGORIES value or ""
  website: string; // optional
  email: string;
}

export type ListYourEventField = keyof ListYourEventInput;
export type ListYourEventErrors = Partial<Record<ListYourEventField, string>>;

/** The body POSTed to /api/suggest-event/submit. */
export interface ListYourEventPayload {
  name: string;
  startDate: string;
  endDate: string;
  venueName: string | null;
  venueCity: string;
  venueState: string;
  categories?: string[];
  sourceUrl?: string;
  suggesterEmail: string;
  source: "community";
  intakeForm: "list-your-event";
}

export const EMPTY_LIST_YOUR_EVENT_INPUT: ListYourEventInput = {
  name: "",
  startDate: "",
  endDate: "",
  town: "",
  state: "",
  venueName: "",
  category: "",
  website: "",
  email: "",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Deliberately loose: the server's zod `.email()` is the authority. This only
// catches the "typed my name into the email box" mistake before a round trip.
const LOOSE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A website the organizer typed, made absolute; null when it is not a URL. */
export function normalizeWebsite(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // "https://myfair" parses, but a host with no dot is a typo, not a site.
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Field errors, keyed by field. Empty object = valid.
 *
 * `today` is injectable so the past-date rule is testable without a clock. The
 * rule compares calendar strings, not instants: an organizer in Maine listing
 * TODAY's fair must not be refused because UTC has already rolled over.
 */
export function validateListYourEvent(
  input: ListYourEventInput,
  today: string = localIsoDate(new Date())
): ListYourEventErrors {
  const errors: ListYourEventErrors = {};
  const name = input.name.trim();
  if (!name) errors.name = "Enter the name of your event.";
  else if (name.length > 200) errors.name = "Keep the name under 200 characters.";

  if (!input.startDate) errors.startDate = "Pick the date your event starts.";
  else if (!isRealIsoDate(input.startDate)) errors.startDate = "That date doesn't look right.";
  else if (input.startDate < today)
    errors.startDate = "That date has passed — list an upcoming date.";

  if (input.endDate) {
    if (!isRealIsoDate(input.endDate)) errors.endDate = "That date doesn't look right.";
    else if (input.startDate && isRealIsoDate(input.startDate) && input.endDate < input.startDate)
      errors.endDate = "The last day can't be before the first day.";
  }

  if (!input.town.trim()) errors.town = "Enter the town it's in.";
  if (!isStateCode(input.state)) errors.state = "Choose a state.";

  const email = input.email.trim();
  if (!email) errors.email = "Enter your email so we can reach you about the listing.";
  else if (!LOOSE_EMAIL.test(email)) errors.email = "That email address doesn't look right.";

  if (input.website.trim() && !normalizeWebsite(input.website))
    errors.website = "Enter a web address like example.com, or leave it blank.";

  return errors;
}

/** Build the submit body. Call only after `validateListYourEvent` is empty. */
export function buildListYourEventPayload(input: ListYourEventInput): ListYourEventPayload {
  const website = normalizeWebsite(input.website);
  const venueName = input.venueName.trim();
  const category = input.category.trim();
  return {
    name: input.name.trim(),
    startDate: input.startDate,
    // A single-day event is the common case; the route expects both ends.
    endDate: input.endDate || input.startDate,
    venueName: venueName || null,
    venueCity: input.town.trim(),
    venueState: input.state,
    ...(category ? { categories: [category] } : {}),
    ...(website ? { sourceUrl: website } : {}),
    suggesterEmail: input.email.trim(),
    source: "community",
    intakeForm: "list-your-event",
  };
}

/** The six states the site covers, for the picker. */
export const LIST_YOUR_EVENT_STATE_OPTIONS = Object.entries(STATES).map(([code, s]) => ({
  value: code,
  label: s.name,
}));

/** YYYY-MM-DD in the browser's own timezone (not UTC). */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
