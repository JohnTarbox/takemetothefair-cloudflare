/**
 * OPE-263 — the `performerIn` Event nodes on a performer page.
 *
 * ## The bug
 *
 * `PerformerSchema` built these stubs inline as
 * `{ "@type": "Event", name, url, startDate? }` — no `location`, ever. Google
 * parses a nested `performerIn` entry as a full Event *declaration*, not a
 * reference, so both indexed performer pages returned Rich Results
 * `verdict: FAIL — Missing field "location"`, suppressing rich results on
 * exactly the pages the performer feature exists to earn them on.
 *
 * This is the K46 shape on a third surface. OPE-244 fixed the two event-page
 * builders and shipped a CI guard, but that guard imports *pure builders* and
 * `PerformerSchema` is a React component with the literal inlined — so the
 * emit site was invisible to it.
 *
 * ## Why this file exists at all
 *
 * Extracting the mapping into a pure builder is the fix AND the guardrail: it
 * mirrors the `buildPlaceJsonLd` extraction K46 already forced, and it makes
 * this surface reachable by `scripts/check-event-jsonld-fields.ts`. A fix that
 * left the literal inside the component would be correct today and unguarded
 * tomorrow.
 *
 * ## Two deliberate choices
 *
 * 1. **Emit a real `location`** rather than reducing to a bare reference. The
 *    ticket allowed either, but `buildPlaceJsonLd` never returns null — it
 *    falls back to an `AdministrativeArea` for the state, or "Location to be
 *    announced" — so this shape *cannot* regress into a missing required field
 *    even for an event with no venue attached. A bare `{"@type":"Event", url}`
 *    would still be parsed as a declaration and still fail.
 * 2. **Suppress an event with no derivable `startDate`** instead of emitting it
 *    dateless. `startDate` is equally required, and OPE-32 set the precedent
 *    that absent beats invalid. An omitted appearance costs one internal link;
 *    an invalid one costs the whole page's rich result.
 */
import { buildPlaceJsonLd, type PlaceVenue } from "@/lib/seo/place-jsonld";

/** One appearance, as the performer page already has it in hand. */
export interface PerformerInEventInput {
  name: string;
  slug: string;
  startDate?: Date | string | null;
  /** The event's venue. Absent is fine — buildPlaceJsonLd still yields a Place. */
  venue?: PlaceVenue | null;
  /** Two-letter state, used when there is no venue. */
  stateCode?: string | null;
}

/**
 * Build the `performerIn` array.
 *
 * Every returned node is a valid Event: `name`, `startDate` and `location` are
 * all guaranteed present. Events that cannot satisfy that are dropped, so the
 * array may be shorter than the input — an empty result means "emit no
 * performerIn at all", which the caller handles.
 */
export function buildPerformerInEvents(
  events: readonly PerformerInEventInput[],
  siteUrl: string
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (const e of events) {
    const startDate = toIsoOrNull(e.startDate);
    // OPE-32: absent beats invalid. A dateless Event node fails the same
    // required-field check that `location` does.
    if (!startDate) continue;

    out.push({
      "@type": "Event",
      name: e.name,
      url: `${siteUrl}/events/${e.slug}`,
      startDate,
      // Never null — see buildPlaceJsonLd's fallback ladder.
      location: buildPlaceJsonLd(e.venue ?? null, e.stateCode ?? null),
    });
  }

  return out;
}

function toIsoOrNull(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
