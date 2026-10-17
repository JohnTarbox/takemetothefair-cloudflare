/**
 * OPE-1479 — the event page's "Visiting" box: Parking, Accessibility, Pets.
 *
 * Each line says WHERE its answer comes from, in this order:
 *   1. organizer — the event's own published value (today only `pet_friendly`
 *      YES/NO, which carries a citation by construction, OPE-1061);
 *   2. venue_google — Google's options for the BUILDING, labelled
 *      "About the venue (from Google):" and never presented as the event's own
 *      arrangements (fair-day parking can be a field lot or a shuttle);
 *   3. unknown — "Not published by the organizer." (placeholder promoter:
 *      "Not published.").
 *
 * NEVER INFER: the inputs are the stored fields and nothing else — no event
 * type, category, sibling fair or prior year. There is deliberately no input
 * that could carry one.
 */
import { petPolicyDisplay } from "@takemetothefair/utils";
import {
  GOOGLE_ACCESSIBILITY_LABELS,
  GOOGLE_PARKING_LABELS,
  googleAmenityPhrases,
} from "@/lib/venues/google-amenities";

export type VisitingTopic = "parking" | "accessibility" | "pets";

export type VisitingLine =
  | { topic: VisitingTopic; source: "organizer"; text: string; citedOn: Date | null }
  | { topic: VisitingTopic; source: "venue_google"; phrases: string[] }
  | { topic: VisitingTopic; source: "unknown"; text: string };

export interface VisitingInput {
  /** events.pet_friendly — the event's OWN answer. */
  petFriendly: string | null | undefined;
  /** Date of the active `pet_friendly` citation, when one exists. */
  petCitedOn: Date | null;
  /** venues.accessibility / venues.parking (Google Places JSON). */
  venueAccessibility: string | null | undefined;
  venueParking: string | null | undefined;
  /** The event sits on a placeholder promoter — no organizer to point at. */
  placeholderPromoter: boolean;
}

export function resolveVisitingLines(input: VisitingInput): VisitingLine[] {
  const unknown = (topic: VisitingTopic): VisitingLine => ({
    topic,
    source: "unknown",
    text: input.placeholderPromoter ? "Not published." : "Not published by the organizer.",
  });
  const fromVenue = (topic: VisitingTopic, phrases: string[]): VisitingLine =>
    phrases.length > 0 ? { topic, source: "venue_google", phrases } : unknown(topic);

  const pet = petPolicyDisplay(input.petFriendly);
  return [
    fromVenue("parking", googleAmenityPhrases(input.venueParking, GOOGLE_PARKING_LABELS)),
    fromVenue(
      "accessibility",
      googleAmenityPhrases(input.venueAccessibility, GOOGLE_ACCESSIBILITY_LABELS)
    ),
    pet
      ? { topic: "pets", source: "organizer", text: pet.label, citedOn: input.petCitedOn }
      : unknown("pets"),
  ];
}
