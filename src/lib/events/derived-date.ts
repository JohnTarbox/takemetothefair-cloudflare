/**
 * OPE-740 — is this event's date something we were told, or something we made up?
 *
 * ## The copy that is currently false
 *
 * The event card's hedged-date tooltip reads:
 *
 *   > "Dates as submitted — not yet confirmed with the organizer"
 *
 * For a rolled-forward row that is **false in the sender's favour**. Nobody
 * submitted these dates. We generated them by shifting last year's by a
 * weekday. The copy tells a reader an organizer supplied a date we have not
 * checked, when in fact no one supplied it at all — a *stronger* claim than the
 * truth, on 124 indexed pages.
 *
 * TENTATIVE is not a privacy state: those pages render, emit `EventScheduled`,
 * and carry no robots meta. Measured in prod 2026-09-06: 124 rows (121
 * `annual_rollover`, 3 `manual_rollover`, and ZERO `auto_rollover` — the
 * committed writer has never run), all TENTATIVE, all upcoming, starting
 * 2027-02-03 through 2027-10-09. Only 2 carry any date citation; 23 have no
 * citation, no `event_days` and no `source_url` at all.
 *
 * ## Why one predicate, shared
 *
 * There are two cohorts and they are discriminated differently:
 *
 *   - the **121-row one-shot cohort** from an offline `annual_rollover` script
 *     (plus 3 `manual_rollover`), which recorded no lineage — verified in prod:
 *     `rolled_from_event_id` is NULL on every row in the table — so
 *     `ingestion_method` is the only tell;
 *   - anything the **live** path (`event-rollover.ts`, `auto_rollover`) writes,
 *     which sets `rolled_from_event_id` properly and has produced zero rows so
 *     far.
 *
 * A gate keyed on either one alone covers one cohort and silently misses the
 * other. Hence `OR`, in one place both surfaces read.
 *
 * ⚠️ `hasDerivedDate` is about ORIGIN and is deliberately not keyed on
 * `dates_confirmed`. Whether a date started as a projection is a fact about how
 * the row was born; it does not change. That is the right basis for *scoping* —
 * which rows the attestation classifier counts.
 *
 * It is NOT the right basis for the COPY. See `shouldShowProjectedDateCopy`.
 */

/**
 * Ingestion methods that mean "we projected this date from a prior edition".
 *
 * `annual_rollover` is the offline script's one-shot cohort (121 rows, created
 * 2026-06-13..15). `auto_rollover` is what the committed writer emits.
 * `manual_rollover` is an operator doing the same thing by hand — the date is
 * still a projection, and the reader deserves the same warning.
 */
export const ROLLOVER_INGESTION_METHODS = [
  "annual_rollover",
  "auto_rollover",
  "manual_rollover",
] as const;

export interface DerivedDateInput {
  ingestionMethod?: string | null;
  rolledFromEventId?: string | null;
}

/**
 * Was this event's date projected rather than sourced?
 *
 * Either tell is sufficient — see the note above on the two cohorts.
 */
export function hasDerivedDate(event: DerivedDateInput | null | undefined): boolean {
  if (!event) return false;
  if (event.rolledFromEventId != null && event.rolledFromEventId !== "") return true;
  const m = event.ingestionMethod ?? "";
  return (ROLLOVER_INGESTION_METHODS as readonly string[]).includes(m);
}

/**
 * The short badge word for a projected date.
 *
 * "Projected" rather than "Expected" or "Tentative": both of those describe how
 * confident we are, and the problem is not our confidence — it is that the
 * reader assumes a person told us. This word says where the date came from.
 */
export const DERIVED_DATE_BADGE = "Projected date";

/**
 * The sentence a reader gets.
 *
 * ⚠️ Written to be true rather than reassuring. It states the origin ("from
 * last year's dates"), the gap ("has not published"), and what to do about it.
 * Compare the copy it replaces, which asserted a submission that never happened.
 *
 * ⚠️ This must render as VISIBLE TEXT, not a `title=` attribute. The old copy
 * lived in a tooltip, which means it IS in the served HTML — so a raw-curl grep
 * would pass while no sighted user on a touch device ever saw it. A guard that
 * only greps the response would have called that shipped.
 */
export const DERIVED_DATE_EXPLANATION =
  "We projected these dates from last year's — the organizer has not published them yet.";

/** The same fact, compressed for a card where the full sentence will not fit. */
export const DERIVED_DATE_SHORT = "Projected from last year — not yet published by the organizer";

/**
 * Should the reader be told these dates are an unconfirmed projection?
 *
 * ## Why this is not just `hasDerivedDate`
 *
 * `ingestion_method` records how a row was BORN and never changes. A date can
 * start as a projection and later be confirmed against the organizer — and two
 * of the 124 did exactly that:
 *
 *   - `litchfield-fair-me-2027` — created 2026-06-15 by the rollover, cited
 *     **2026-08-29** against `maine.gov/dacf/ard/events/fairs/…2026-2029-f…`,
 *     the state's official multi-year fair schedule.
 *   - `marthas-vineyard-fair-ma-2027` — created 2026-06-15, cited
 *     **2026-08-17** against the Agricultural Society's own site.
 *
 * Both carry `dates_confirmed = 1` with an `official_website` citation on
 * `start_date` AND `end_date`. OPE-740's description — and my own first two
 * restatements of it — treated `dates_confirmed = 1` on a rolled row as
 * self-evidently the bug. It is not: on these two it is correct, and the
 * confirmation postdates the projection by ten and eleven weeks.
 *
 * ⚠️ Keying the copy on origin alone therefore reproduces the original defect
 * INVERTED. The first version of this shipped told a reader of the Litchfield
 * page "the organizer has not published them yet" while we held an official
 * State of Maine citation for exactly those dates. Wrong in the other
 * direction, and wrong about a source we had already read.
 *
 * ## Why `datesConfirmed` is the right second term
 *
 * It is the only field that means "somebody checked", and it is on the event
 * row, so both render surfaces can consult it without loading citations.
 *
 * The obvious objection — OPE-384's Dartmouth case, where `dates_confirmed`
 * was set with nothing behind it — is already somebody else's job:
 * `assessAllUncitedConfirmedDates` reds exactly that condition. Making this
 * predicate re-litigate it would be two controls answering one question, and
 * the first to drift would be the one nothing tests.
 *
 * So: each control does one job. This one asks "do we still believe nobody has
 * confirmed these?", and OPE-384's asks "is that belief backed?".
 */
export function shouldShowProjectedDateCopy(
  event: (DerivedDateInput & { datesConfirmed?: boolean | number | null }) | null | undefined
): boolean {
  if (!hasDerivedDate(event)) return false;
  const confirmed = event?.datesConfirmed;
  // D1 stores this as an integer; Drizzle maps it to boolean. Accept both
  // rather than trusting one — a `1` read as truthy-object would invert this.
  return !(confirmed === true || confirmed === 1);
}
