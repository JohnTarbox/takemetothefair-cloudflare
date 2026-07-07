/**
 * OPE-113 PR#2 — pure performer-name match ranking for the admin event-edit
 * "add performer" flow (main-app side; the MCP `create_or_link_performer` tool
 * has the mcp-server equivalent). Surfaces likely duplicates for MANUAL confirm
 * rather than auto-linking — the known dash/abbrev misses ("Mr Drew" vs "Mr. Drew
 * and His Animals Too") mean the score alone isn't trusted (spec §4.1).
 *
 * Pure + no I/O.
 */
import { combinedSimilarity } from "@takemetothefair/utils";

/** ≥ this combined similarity is a likely duplicate worth surfacing. */
export const PERFORMER_FUZZY_THRESHOLD = 0.92;

export interface PerformerCandidate {
  id: string;
  name: string;
  slug: string;
}

export interface PerformerMatch extends PerformerCandidate {
  score: number;
}

/**
 * Rank candidates against a name, returning those at/above the threshold,
 * best first. An empty result means "no likely duplicate — safe to create".
 */
export function rankPerformerMatches(
  name: string,
  candidates: PerformerCandidate[],
  threshold: number = PERFORMER_FUZZY_THRESHOLD
): PerformerMatch[] {
  const q = name.trim();
  if (!q) return [];
  return candidates
    .map((c) => ({ ...c, score: combinedSimilarity(q, c.name, 0.6, threshold) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((c) => ({ ...c, score: Number(c.score.toFixed(3)) }));
}
