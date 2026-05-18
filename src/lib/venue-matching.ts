/**
 * Server-side venue auto-link for the suggest-event submit pipeline.
 *
 * Used by /api/suggest-event/submit when the caller (community form,
 * vendor form, email-import handler) provides a venue NAME but not a
 * venue_id. We try to find a single confident match in the venues
 * table; if found, the event row inherits venue_id + state_code from
 * the matched venue. If 0 matches or 2+ ambiguous matches, the event
 * keeps venue_id=NULL and the admin reviews + links manually.
 *
 * This is intentionally MORE CONSERVATIVE than the user-facing
 * /api/suggest-event/match-venue endpoint (which returns top-N fuzzy
 * matches for UI display at 0.6+ similarity). Auto-link runs without
 * human review, so we require either an exact normalized-name match
 * or a strong fuzzy match with corroborating address evidence.
 *
 * Tradeoff: prefer false negatives (admin manually links) over false
 * positives (wrong venue silently linked). Existing event_data
 * citations and IndexNow pings flow from venue_id; wrong link is much
 * worse than null.
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { venues } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Strip down a venue name for comparison. Lower-cases, normalizes
 * common street-suffix variants ("Lane"/"Ln", "Street"/"St", etc.) so
 * an address mismatch on suffix-form doesn't block a real match, and
 * strips non-alphanumeric chars + collapses whitespace.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bln\b/g, "lane")
    .replace(/\bst\b/g, "street")
    .replace(/\brd\b/g, "road")
    .replace(/\bave\b/g, "avenue")
    .replace(/\bblvd\b/g, "boulevard")
    .replace(/\bdr\b/g, "drive")
    .replace(/\bct\b/g, "court")
    .replace(/\bpl\b/g, "place")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VenueAutoLinkResult {
  /** Matched venue id; null means leave venue_id NULL on the event. */
  venueId: string | null;
  /** State to inherit onto the event row's state_code. Sourced from the
   *  matched venue first, then from extracted venueState, then null. */
  stateCode: string | null;
  /** Reason for the decision — useful for admin logs / audit trail. */
  decision:
    | "no-name"
    | "exact-name+state"
    | "exact-name-only"
    | "address-corroborated"
    | "ambiguous"
    | "no-match";
  /** Ambiguous matches the admin should choose between. Populated only
   *  when decision === "ambiguous". */
  candidates?: Array<{ id: string; name: string; state: string | null }>;
}

export interface AutoLinkInput {
  venueName: string | null | undefined;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
}

/**
 * Attempt to auto-link an event submission to an existing venue.
 *
 * Algorithm (in order, first matching tier wins):
 *   1. Exact normalized-name match WITH state agreement → confident link
 *   2. Exact normalized-name match (no state given OR no state on row)
 *      AND only 1 candidate → link
 *   3. Multiple exact-name matches → ambiguous, return candidates list
 *   4. Address-only corroboration (normalized address equality, name
 *      LIKE contains) → link
 *   5. No match → return no-match, falls back to whatever stateCode the
 *      caller extracted from the page.
 */
export async function autoLinkVenue(db: Db, input: AutoLinkInput): Promise<VenueAutoLinkResult> {
  const rawName = input.venueName?.trim();
  if (!rawName) {
    return {
      venueId: null,
      stateCode: input.venueState?.trim().toUpperCase() || null,
      decision: "no-name",
    };
  }
  const normalizedName = normalize(rawName);
  const state = input.venueState?.trim().toUpperCase() || null;
  const address = input.venueAddress?.trim() || null;

  // Pull a candidate set by LIKE on the first 2 words of the name. Bounded
  // small in practice (venues ≪ 10k rows; first-token matches < 50).
  const firstTokens = normalizedName.split(" ").slice(0, 2).join(" ");
  const candidates = await db
    .select({
      id: venues.id,
      name: venues.name,
      state: venues.state,
      address: venues.address,
    })
    .from(venues)
    .where(sql`LOWER(${venues.name}) LIKE ${"%" + firstTokens.split(" ")[0] + "%"}`)
    .limit(100);

  // Tier 1+2: exact normalized-name match
  const exactNameMatches = candidates.filter((v) => normalize(v.name) === normalizedName);
  if (exactNameMatches.length === 1) {
    const m = exactNameMatches[0];
    const stateAgreement = !state || !m.state || m.state.toUpperCase() === state;
    return {
      venueId: m.id,
      stateCode: m.state ? m.state.toUpperCase() : state,
      decision: stateAgreement ? "exact-name+state" : "exact-name-only",
    };
  }
  if (exactNameMatches.length > 1) {
    // Filter by state if provided; might narrow to 1
    if (state) {
      const inState = exactNameMatches.filter((v) => v.state?.toUpperCase() === state);
      if (inState.length === 1) {
        return {
          venueId: inState[0].id,
          stateCode: state,
          decision: "exact-name+state",
        };
      }
    }
    return {
      venueId: null,
      stateCode: state,
      decision: "ambiguous",
      candidates: exactNameMatches.map((v) => ({ id: v.id, name: v.name, state: v.state })),
    };
  }

  // Tier 4: address-corroborated match. Only relevant if we have both an
  // address AND a name token; check candidates whose address normalizes
  // to the same string AND whose name contains the first token.
  if (address) {
    const normalizedAddress = normalize(address);
    const firstNameTok = normalizedName.split(" ")[0];
    const addressMatches = candidates.filter(
      (v) =>
        v.address &&
        normalize(v.address) === normalizedAddress &&
        normalize(v.name).includes(firstNameTok)
    );
    if (addressMatches.length === 1) {
      const m = addressMatches[0];
      return {
        venueId: m.id,
        stateCode: m.state ? m.state.toUpperCase() : state,
        decision: "address-corroborated",
      };
    }
  }

  return {
    venueId: null,
    stateCode: state,
    decision: "no-match",
  };
}

/**
 * Fallback state derivation: when no venue match and no extracted state,
 * try to find a New England state mention in the description text. Used
 * only as a last resort; events for which this fires also flag for admin
 * review since "we guessed from prose" is much weaker than "venue gave us
 * a stateCode."
 */
const NE_STATE_RE =
  /\b(NH|New Hampshire|MA|Massachusetts|ME|Maine|VT|Vermont|CT|Connecticut|RI|Rhode Island)\b/g;
const STATE_NAME_TO_CODE: Record<string, string> = {
  nh: "NH",
  "new hampshire": "NH",
  ma: "MA",
  massachusetts: "MA",
  me: "ME",
  maine: "ME",
  vt: "VT",
  vermont: "VT",
  ct: "CT",
  connecticut: "CT",
  ri: "RI",
  "rhode island": "RI",
};

export function deriveStateFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const found = new Set<string>();
  for (const m of text.matchAll(NE_STATE_RE)) {
    const code = STATE_NAME_TO_CODE[m[1].toLowerCase()];
    if (code) found.add(code);
  }
  return found.size === 1 ? [...found][0] : null;
}
