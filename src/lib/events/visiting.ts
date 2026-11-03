/**
 * OPE-1479 — the event page's "Visiting" box: Parking, Accessibility, Pets.
 *
 * Each line says WHERE its answer comes from, in this order:
 *   1. organizer — the event's own published value: `pet_friendly` YES/NO
 *      (OPE-1061) and `parking_notes` / `accessibility_notes` (OPE-1481), each
 *      of which carries a verbatim citation by construction;
 *   2. venue_google — Google's options for the BUILDING, labelled
 *      "About the venue (from Google):" and never presented as the event's own
 *      arrangements (fair-day parking can be a field lot or a shuttle);
 *   3. unknown — "Not published by the organizer." (placeholder promoter:
 *      "Not published.").
 *
 * Pets has one extra rung between 1 and 3 (John, 2026-10-17 on OPE-1479):
 * the VENUE's own rule (`venues.pet_friendly`), labelled "At this venue: …",
 * and only when the event's own value is UNSET — nobody has looked. An event
 * answer, or NOT_PUBLISHED (we looked; the organizer is silent), is never
 * replaced by the building's rule. This is the one venue→event read the
 * OPE-1061 guard allows (`pet-policy-render-ope1061.test.ts`).
 *
 * NEVER INFER: the inputs are the stored fields and nothing else — no event
 * type, category, sibling fair or prior year. There is deliberately no input
 * that could carry one.
 */
import { petPolicyDisplay, venuePetPolicyDisplay } from "@takemetothefair/utils";
import {
  GOOGLE_ACCESSIBILITY_LABELS,
  GOOGLE_PARKING_LABELS,
  googleAmenityPhrases,
} from "@/lib/venues/google-amenities";

export type VisitingTopic = "parking" | "accessibility" | "pets";

export type VisitingLine =
  | { topic: VisitingTopic; source: "organizer"; text: string; citedOn: Date | null }
  | { topic: VisitingTopic; source: "venue_google"; phrases: string[] }
  | { topic: VisitingTopic; source: "venue_rule"; text: string }
  | { topic: VisitingTopic; source: "unknown"; text: string };

export interface VisitingInput {
  /** events.pet_friendly — the event's OWN answer. */
  petFriendly: string | null | undefined;
  /** Date of the active `pet_friendly` citation, when one exists. */
  petCitedOn: Date | null;
  /** venues.accessibility / venues.parking (Google Places JSON). */
  venueAccessibility: string | null | undefined;
  venueParking: string | null | undefined;
  /** events.parking_notes / accessibility_notes — the organizer's own words (OPE-1481). */
  parkingNotes?: string | null;
  parkingCitedOn?: Date | null;
  accessibilityNotes?: string | null;
  accessibilityCitedOn?: Date | null;
  /** venues.pet_friendly — the VENUE's own rule; used only when the event's is UNSET. */
  venuePetFriendly: string | null | undefined;
  /** The event sits on a placeholder promoter — no organizer to point at. */
  placeholderPromoter: boolean;
}

const VENUE_PET_TEXT = {
  allowed: "At this venue: pets generally allowed",
  restricted: "At this venue: service animals only — no pets",
} as const;

export function resolveVisitingLines(input: VisitingInput): VisitingLine[] {
  const unknown = (topic: VisitingTopic): VisitingLine => ({
    topic,
    source: "unknown",
    text: input.placeholderPromoter ? "Not published." : "Not published by the organizer.",
  });
  const fromVenue = (topic: VisitingTopic, phrases: string[]): VisitingLine =>
    phrases.length > 0 ? { topic, source: "venue_google", phrases } : unknown(topic);
  // The organizer's own note wins its line; Google's building data is the fallback.
  const organizerOr = (
    topic: VisitingTopic,
    note: string | null | undefined,
    citedOn: Date | null | undefined,
    fallback: () => VisitingLine
  ): VisitingLine =>
    note?.trim()
      ? { topic, source: "organizer", text: note.trim(), citedOn: citedOn ?? null }
      : fallback();

  const pet = petPolicyDisplay(input.petFriendly);
  const eventPetUnset = input.petFriendly == null || input.petFriendly === "UNSET";
  const venuePet = eventPetUnset ? venuePetPolicyDisplay(input.venuePetFriendly) : null;
  const petLine: VisitingLine = pet
    ? { topic: "pets", source: "organizer", text: pet.label, citedOn: input.petCitedOn }
    : venuePet
      ? { topic: "pets", source: "venue_rule", text: VENUE_PET_TEXT[venuePet.tone] }
      : unknown("pets");
  return [
    organizerOr("parking", input.parkingNotes, input.parkingCitedOn, () =>
      fromVenue("parking", googleAmenityPhrases(input.venueParking, GOOGLE_PARKING_LABELS))
    ),
    organizerOr("accessibility", input.accessibilityNotes, input.accessibilityCitedOn, () =>
      fromVenue(
        "accessibility",
        googleAmenityPhrases(input.venueAccessibility, GOOGLE_ACCESSIBILITY_LABELS)
      )
    ),
    petLine,
  ];
}
