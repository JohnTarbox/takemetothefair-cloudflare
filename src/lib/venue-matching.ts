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
import { adminActions, venues } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { combinedSimilarity, normalizeString, tokenize } from "@takemetothefair/utils";

type Db = DrizzleD1Database<typeof schema>;

/** Confidence floor for a fuzzy-only match (no address corroboration).
 *  0.85 catches "Downtown Farmington" vs "Farmington Downtown" type
 *  reorderings + "Sterling Hall" vs "Starling Hall" single-letter typos
 *  while rejecting "Town Hall" vs "Town Square". */
const FUZZY_HIGH_CONFIDENCE = 0.85;
/** Lower floor when the address token also matches — catches the
 *  "Farmington Downtown Commons" vs "Downtown Farmington" + same-street
 *  case where the name is paraphrased but the location is clearly the
 *  same physical venue. */
const FUZZY_WITH_ADDRESS_CORROBORATION = 0.7;

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
    | "fuzzy-name+state"
    | "fuzzy-name+address"
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
    const candidatePairs = exactNameMatches.map((v) => ({
      id: v.id,
      name: v.name,
      state: v.state,
    }));
    await recordAmbiguousMatch(db, "exact", normalizedName, state, candidatePairs);
    return {
      venueId: null,
      stateCode: state,
      decision: "ambiguous",
      candidates: candidatePairs,
    };
  }

  // Tier 3: fuzzy name match via Levenshtein. Catches reorderings
  // ("Downtown Farmington" vs "Farmington Downtown"), single-letter
  // typos ("Starling Hall" vs "Sterling Hall"), and AI paraphrases
  // ("Downtown Farmington Office" vs "Downtown Farmington"). Two
  // thresholds:
  //   - 0.85+ alone + state agreement: confident link
  //   - 0.70–0.85 + address-token corroboration: confident link
  //   - 2+ at the higher threshold (in state): ambiguous
  //
  // Constrained by state when known — fuzzy across states is dangerous
  // (e.g. "Town Hall" exists in every state; the address-corroboration
  // tier below handles cross-state cases more safely via address match).
  // Tier 3a: same bag of words after normalization. Catches simple
  // reorderings ("Farmington Downtown" vs "Downtown Farmington") and
  // shared-token venues regardless of character-position. We treat this
  // as a strong-confidence signal — venues that share the same tokens
  // are very likely the same place. Pure Levenshtein scores reorderings
  // ~0.2 because most chars are in the wrong position; token-set
  // equality nails it.
  const inputTokens = tokenize(normalizedName);
  // combinedSimilarity blends Levenshtein with Jaccard token similarity
  // (default 60/40 weights). Used for Tier 3b (typos, spelling variants)
  // where token-bag isn't exact but characters are close.
  const scoredCandidates = candidates
    .map((v) => {
      const candNorm = normalize(v.name);
      const candTokens = tokenize(candNorm);
      const sameBag =
        candTokens.size === inputTokens.size &&
        candTokens.size > 0 &&
        [...candTokens].every((t) => inputTokens.has(t));
      return {
        id: v.id,
        name: v.name,
        state: v.state,
        address: v.address,
        sameBag,
        similarity: sameBag ? 1.0 : combinedSimilarity(normalizedName, candNorm),
      };
    })
    .filter((v) => v.similarity >= FUZZY_WITH_ADDRESS_CORROBORATION)
    .sort((a, b) => b.similarity - a.similarity);

  const highConfidenceInState = scoredCandidates.filter(
    (v) =>
      v.similarity >= FUZZY_HIGH_CONFIDENCE &&
      (!state || !v.state || v.state.toUpperCase() === state)
  );
  if (highConfidenceInState.length === 1) {
    const m = highConfidenceInState[0];
    return {
      venueId: m.id,
      stateCode: m.state ? m.state.toUpperCase() : state,
      decision: "fuzzy-name+state",
    };
  }
  if (highConfidenceInState.length > 1) {
    const candidatePairs = highConfidenceInState.map((v) => ({
      id: v.id,
      name: v.name,
      state: v.state,
    }));
    await recordAmbiguousMatch(db, "fuzzy", normalizedName, state, candidatePairs);
    return {
      venueId: null,
      stateCode: state,
      decision: "ambiguous",
      candidates: candidatePairs,
    };
  }

  // Mid-tier fuzzy + address-token corroboration. Only fires when we have
  // an address AND a candidate scored above the lower fuzzy floor; checks
  // that at least one normalized token from the input address also appears
  // in the candidate's normalized address.
  if (address) {
    const normalizedAddress = normalize(address);
    const addressTokens = normalizedAddress.split(" ").filter((t) => t.length >= 3);
    const corroborated = scoredCandidates.filter((v) => {
      if (!v.address) return false;
      const candAddr = normalize(v.address);
      return addressTokens.some((tok) => candAddr.includes(tok));
    });
    if (corroborated.length === 1) {
      const m = corroborated[0];
      return {
        venueId: m.id,
        stateCode: m.state ? m.state.toUpperCase() : state,
        decision: "fuzzy-name+address",
      };
    }
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
 * Record an ambiguous venue match to admin_actions so the admin UI can
 * surface "this event came in with venueName='X', matched these 3 venues,
 * here are the choices." Best-effort; if the write fails the caller still
 * gets the ambiguous decision back and the event stays venue_id=NULL.
 *
 * Reuses the existing admin_actions table — venue.ambiguous_match is a
 * sibling of venue.create / venue.update / vendor.enrichment_log / etc.
 * No new table needed.
 */
async function recordAmbiguousMatch(
  db: Db,
  tier: "exact" | "fuzzy",
  normalizedInputName: string,
  state: string | null,
  candidatesList: Array<{ id: string; name: string; state: string | null }>
): Promise<void> {
  try {
    await db.insert(adminActions).values({
      action: "venue.ambiguous_match",
      actorUserId: null,
      targetType: "venue",
      // Use the first candidate's id as the target. The full set is in
      // payload_json so the admin sees all options; targetId just makes
      // the row clickable to one of them.
      targetId: candidatesList[0]?.id ?? "unknown",
      payloadJson: JSON.stringify({
        tier,
        normalizedInputName,
        state,
        candidates: candidatesList,
      }),
      createdAt: new Date(),
    });
  } catch {
    // Best-effort — never block the autoLink decision on the audit row.
  }
}

// Re-export normalizeString so the unit test can reach the same
// normalization path the matcher uses without grabbing it from a
// transitive package.
export { normalizeString as _normalizeForTest };

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
