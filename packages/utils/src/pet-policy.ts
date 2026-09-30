/**
 * OPE-1061 — the narrow, four-state `pet_friendly` field on events AND venues.
 *
 * Two fair-goers asked "can I bring my dog?" (OPE-852's reopen trigger fired
 * 2026-09-17), and the second asked from an event page whose row held no answer.
 * John ruled: build it, narrow — pets only, two tables, no `policies` blob.
 *
 * One definition, shared by every writer (MCP update_event / update_venue) and
 * every reader (the event and venue pages, the support briefing), because the
 * four rules below fail by stranding a person at a gate:
 *
 *   1. FOUR states, not three. `UNSET` = nobody has looked (the research
 *      backlog); `NOT_PUBLISHED` = we looked and the organizer is silent (the
 *      promoter-outreach backlog). "Unknown" would collapse the two.
 *   2. `NO` never renders as a bare "No" — "Service animals only". The
 *      restrictive statements in our own data all carry that exception.
 *   3. `YES`/`NO` require evidence: a source URL AND a verbatim excerpt.
 *      `NOT_PUBLISHED` requires the page checked and what was checked.
 *   4. NO INHERITANCE and NO INFERENCE. An event's value answers for the event
 *      only — nothing here takes a venue, a category or a sibling as input, on
 *      purpose. The same fairgrounds hosts an ag fair (service animals only)
 *      and a lawn craft fair (leashed dogs welcome).
 */

export const PET_FRIENDLY_VALUES = ["UNSET", "YES", "NO", "NOT_PUBLISHED"] as const;
export type PetFriendly = (typeof PET_FRIENDLY_VALUES)[number];

export interface PetFriendlyEvidence {
  source_url: string;
  source_type:
    | "official_website"
    | "news_article"
    | "press_release"
    | "social_media"
    | "user_submitted"
    | "other";
  source_name?: string | null;
  /** YES/NO: the organizer's own words, verbatim. */
  excerpt?: string | null;
  /** NOT_PUBLISHED: what was checked and found silent (pages, sections). */
  checked?: string | null;
}

/**
 * Why a write must be refused, or null when it may proceed. Called BEFORE any
 * row is touched, so a refused value leaves nothing half-written.
 */
export function petFriendlyWriteError(
  value: PetFriendly,
  evidence: PetFriendlyEvidence | null | undefined
): string | null {
  if (value === "UNSET") return null;
  if (!evidence?.source_url) {
    return value === "NOT_PUBLISHED"
      ? "pet_friendly=NOT_PUBLISHED needs pet_friendly_evidence naming the page you checked (source_url) and what you checked (checked)."
      : `pet_friendly=${value} needs pet_friendly_evidence with the source_url and a verbatim excerpt of the organizer's own statement. A confident value with nothing behind it strands someone at a gate.`;
  }
  if ((value === "YES" || value === "NO") && !evidence.excerpt?.trim()) {
    return `pet_friendly=${value} needs pet_friendly_evidence.excerpt — the organizer's words, verbatim, not a summary.`;
  }
  if (value === "NOT_PUBLISHED" && !evidence.checked?.trim()) {
    return "pet_friendly=NOT_PUBLISHED needs pet_friendly_evidence.checked — what you looked at and found silent, so the next pass can skip it.";
  }
  return null;
}

/** The citation `value` + `notes` a write records. The excerpt travels in its
 *  own column where the table has one; `notes` always carries it too, so the
 *  venue table (no excerpt column) holds the same evidence. */
export function petFriendlyCitationNotes(
  value: PetFriendly,
  evidence: PetFriendlyEvidence
): string {
  if (value === "NOT_PUBLISHED") return `Checked, nothing published: ${evidence.checked ?? ""}`;
  return `Verbatim: "${evidence.excerpt ?? ""}"`;
}

export interface PetPolicyDisplay {
  /** The whole answer line. Never a bare "No". */
  label: string;
  tone: "allowed" | "restricted";
}

/**
 * What a page may say. `UNSET` and `NOT_PUBLISHED` both render as ABSENT —
 * neither may ever read as "No". Takes one value; there is deliberately no
 * venue parameter, so an event answer cannot be composed from a venue's.
 */
export function petPolicyDisplay(value: string | null | undefined): PetPolicyDisplay | null {
  if (value === "YES") return { label: "Pets allowed, per the organizer", tone: "allowed" };
  if (value === "NO") return { label: "Service animals only — no pets", tone: "restricted" };
  return null;
}

/** The venue page's line, labelled as the venue's own policy. */
export function venuePetPolicyDisplay(value: string | null | undefined): PetPolicyDisplay | null {
  if (value === "YES") return { label: "Pets generally allowed at this venue", tone: "allowed" };
  if (value === "NO") {
    return { label: "Service animals only at this venue — no pets", tone: "restricted" };
  }
  return null;
}
