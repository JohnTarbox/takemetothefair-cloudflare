/**
 * Shared schema.org `Place` builder — the single source of truth for the
 * `location` node emitted by event + series + venue structured data.
 *
 * K46 (2026-06-26): the EventSeries builder (`series-schema-org.ts`) was
 * emitting `EventSeries` + `subEvent[]` with NO `location`, which Google's
 * Rich Results flagged as `Missing field "location"` (ERROR) on every series
 * landing page. `EventSchema.tsx` already built a correct Place inline; this
 * module factors that exact logic out so BOTH builders agree on the shape and
 * the A10 deploy-time JSON-LD validator can assert one canonical contract.
 *
 * Pure + side-effect-free (no React) so it imports cleanly into the pure
 * `src/lib/series/*` schema modules and into the `EventSchema` component alike.
 *
 * `undefined`-valued keys are intentional: every caller serialises with
 * `JSON.stringify` (directly or via `JSON.parse(JSON.stringify(...))`), which
 * drops `undefined` properties — so an absent street address simply omits
 * `streetAddress` rather than emitting `null`.
 */
import { displayVenueName } from "@/lib/venue-display";
import { getStateName } from "@/lib/states";

/** Venue fields the Place node reads. Superset-compatible with the event/venue rows. */
export interface PlaceVenue {
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Build a schema.org `Place` node from a venue. When `venue` is null/undefined
 * the node falls back to "Location to be announced" (with the optional state
 * code as `addressRegion`) — this still satisfies Google's required-field check
 * so the rich result validates even before a venue is attached.
 *
 * Mirrors `EventSchema`'s prior inline logic exactly:
 *   - `displayVenueName` for the name (so a street-address-named venue renders
 *     "Event venue in {City}, {State}" instead of "18 Spring Street"),
 *   - `addressCountry: "US"`,
 *   - `GeoCoordinates` only when BOTH latitude and longitude are present.
 */
export function buildPlaceJsonLd(
  venue: PlaceVenue | null | undefined,
  fallbackStateCode?: string | null
): Record<string, unknown> {
  if (!venue) {
    // OPE-244 #4 — a venue-less (statewide) event: emit an AdministrativeArea
    // named for the state ("Maine" beats "Location to be announced") when we can
    // resolve the code. AdministrativeArea is a schema.org Place subtype, so
    // it's a valid Event `location`. Falls back to the generic Place only when
    // there's no usable state code.
    const stateName = getStateName(fallbackStateCode);
    if (stateName) {
      return {
        "@type": "AdministrativeArea",
        name: stateName,
        address: {
          "@type": "PostalAddress",
          addressRegion: fallbackStateCode || undefined,
          addressCountry: "US",
        },
      };
    }
    return {
      "@type": "Place",
      name: "Location to be announced",
      address: {
        "@type": "PostalAddress",
        addressRegion: fallbackStateCode || undefined,
        addressCountry: "US",
      },
    };
  }
  return {
    "@type": "Place",
    name: displayVenueName(venue),
    address: {
      "@type": "PostalAddress",
      streetAddress: venue.address || undefined,
      addressLocality: venue.city || undefined,
      addressRegion: venue.state || undefined,
      postalCode: venue.zip || undefined,
      addressCountry: "US",
    },
    geo:
      venue.latitude && venue.longitude
        ? {
            "@type": "GeoCoordinates",
            latitude: venue.latitude,
            longitude: venue.longitude,
          }
        : undefined,
  };
}
