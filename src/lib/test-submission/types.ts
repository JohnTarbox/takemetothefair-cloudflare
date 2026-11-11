/**
 * OPE-1625 — the report a test submission returns. One shape for every entry
 * point (a pasted calendar, a form, an API `dry_run`), so a promoter sees the
 * same words whichever way they test.
 *
 * PUBLIC FIELDS ONLY. A `match` carries the listing's public page URL, its name
 * and the public fields that would change — never a contact, an internal note,
 * another submitter, or any column a visitor cannot see. A match to a listing
 * that is not public yet carries no URL and no values at all.
 */

/** Where a value came from, in the promoter's words. */
export type SourceLabel =
  "from your calendar feed" | "from the linked page" | "from the form" | "from your API request";

export type ReadFieldKey =
  | "name"
  | "start"
  | "end"
  | "daily_hours"
  | "venue"
  | "address"
  | "admission"
  | "categories"
  | "vendor_application_url"
  | "application_deadline"
  | "booth_fee"
  | "image_url"
  | "description"
  | "event_url";

export interface ReadField {
  field: ReadFieldKey;
  label: string;
  /** As we read it, for display. Null when the source did not give it. */
  value: string | null;
  /** Null exactly when `value` is null. */
  source: SourceLabel | null;
}

export type SkipReason =
  | "past_date"
  | "outside_new_england"
  | "not_an_event"
  | "closure"
  | "childrens_program"
  | "excluded_organizer"
  | "cancelled"
  | "invalid"
  | "listed_by_another_organizer"
  | "external_id_conflict"
  | "in_progress"
  | "not_found";

export interface FieldChange {
  field: string;
  current: string | null;
  proposed: string | null;
}

export interface PublicListing {
  /** Absolute public page URL; null when the listing is not public. */
  url: string | null;
  /** The public name; null when the listing is not public. */
  name: string | null;
  public: boolean;
}

export type Outcome =
  | { kind: "new"; summary: string }
  | { kind: "match"; summary: string; listing: PublicListing; changes: FieldChange[] }
  | { kind: "skip"; summary: string; reason: SkipReason };

export type ProblemCode =
  | "missing_required"
  | "invalid_value"
  | "am_pm_slip"
  | "state_only_location"
  | "cancelled_in_text"
  | "past_date"
  | "incomplete_location"
  | "outside_new_england"
  | "category_left_off";

export interface Problem {
  code: ProblemCode;
  severity: "error" | "warning";
  field: string | null;
  message: string;
}

export interface ItemReport {
  title: string;
  /** The feed's own id for the item, or the API external_id. */
  external_id: string | null;
  read: ReadField[];
  outcome: Outcome;
  problems: Problem[];
}

export interface Counts {
  read: number;
  would_pick_up: number;
  new: number;
  match: number;
  skipped: number;
  with_problems: number;
}

export interface CalendarCheckReport {
  dry_run: true;
  source: {
    url: string;
    final_url: string;
    kind: "ical" | "tec_rest" | "jsonld";
    calendar_name: string | null;
    pages_read: number;
  };
  window: { start: string; end: string };
  counts: Counts;
  /** Things about the read as a whole (a page cap, an RRULE we did not expand). */
  notes: string[];
  /** True when more items were read than the report lists. */
  truncated: boolean;
  items: ItemReport[];
}
