/**
 * Similarity scoring for duplicate detection.
 *
 * Normalized Levenshtein + Jaccard token overlap. Used by the main app's
 * `/admin/duplicates` page and by the MCP `create_or_link_vendor` tool's
 * fuzzy-match dedup path. Pure functions — safe at edge and in tests.
 *
 * Promoted from `src/lib/duplicates/similarity.ts` so the MCP server (which
 * lives in a separate workspace) can share it without duplication. The
 * main-app file remains as a re-export shim for backward compat.
 */

export function normalizeString(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Normalized Levenshtein similarity (0–1). 1 = identical, 0 = disjoint.
 *
 * `threshold` enables an early-exit short-circuit: if string-length alone makes
 * exceeding the threshold impossible, return 0 without running the O(m×n)
 * matrix fill. Important for fuzzy-match candidate scans that compare against
 * hundreds of rows.
 */
export function levenshteinSimilarity(a: string, b: string, threshold?: number): number {
  const normalizedA = normalizeString(a);
  const normalizedB = normalizeString(b);

  if (normalizedA === normalizedB) return 1;
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;

  const maxLength = Math.max(normalizedA.length, normalizedB.length);
  const minLength = Math.min(normalizedA.length, normalizedB.length);
  const lengthDiff = maxLength - minLength;

  if (threshold !== undefined) {
    const maxPossibleSimilarity = 1 - lengthDiff / maxLength;
    if (maxPossibleSimilarity < threshold) {
      return 0;
    }
  }

  const distance = levenshteinDistance(normalizedA, normalizedB);
  return 1 - distance / maxLength;
}

/**
 * Tokenize for Jaccard set similarity. Returns a Set (deduped) of normalized
 * word tokens. Note: distinct from MCP's `helpers.ts:tokenize` which returns
 * an array of event-name keyword tokens with stop-word filtering — both names
 * coexist because both are correct for their domains. Don't import both into
 * the same file.
 */
export function tokenize(str: string): Set<string> {
  const normalized = normalizeString(str);
  const tokens = normalized.split(" ").filter((t) => t.length > 0);
  return new Set(tokens);
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  const aArray = Array.from(a);
  const bArray = Array.from(b);
  const intersection = new Set(aArray.filter((x) => b.has(x)));
  const union = new Set(aArray.concat(bArray));

  return intersection.size / union.size;
}

export function tokenJaccardSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenize(a), tokenize(b));
}

/**
 * Weighted average of Levenshtein and Jaccard. Default 60/40 favors
 * character-level similarity over bag-of-words, which gives the right answer
 * for vendor-name dedup (e.g. "Rogers Photography" vs "Roger's Photography").
 *
 * `threshold` is propagated into the Levenshtein early-exit so candidate
 * scans bail before the expensive matrix fill when length difference alone
 * makes the threshold unreachable.
 */
export function combinedSimilarity(
  a: string,
  b: string,
  levenshteinWeight: number = 0.6,
  threshold?: number
): number {
  const jaccardWeight = 1 - levenshteinWeight;
  const minLevSim =
    threshold !== undefined
      ? Math.max(0, (threshold - jaccardWeight) / levenshteinWeight)
      : undefined;

  const levSim = levenshteinSimilarity(a, b, minLevSim);

  if (minLevSim !== undefined && levSim < minLevSim) {
    return 0;
  }

  const jacSim = tokenJaccardSimilarity(a, b);
  return levSim * levenshteinWeight + jacSim * jaccardWeight;
}

/**
 * O(n²) pairwise scan. Used by the admin duplicates page on the full table —
 * call sites already cap the entity set size. Not suitable for streaming.
 *
 * `getExactMatchKey` lets callers short-circuit on a strong identity signal
 * (e.g. Google Place ID for venues): two entities sharing a non-empty key are
 * scored 0.99 regardless of name similarity.
 */
export function findDuplicatePairs<T extends { id: string }>(
  entities: T[],
  getComparisonString: (entity: T) => string,
  threshold: number = 0.7,
  getExactMatchKey?: (entity: T) => string | null | undefined
): Array<{ entity1: T; entity2: T; similarity: number }> {
  const pairs: Array<{ entity1: T; entity2: T; similarity: number }> = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      let similarity: number;
      const key1 = getExactMatchKey?.(entities[i]);
      const key2 = getExactMatchKey?.(entities[j]);
      if (key1 && key2 && key1 === key2) {
        similarity = 0.99;
      } else {
        const str1 = getComparisonString(entities[i]);
        const str2 = getComparisonString(entities[j]);
        similarity = combinedSimilarity(str1, str2, 0.6, threshold);
      }

      if (similarity >= threshold) {
        pairs.push({
          entity1: entities[i],
          entity2: entities[j],
          similarity: Math.round(similarity * 100) / 100,
        });
      }
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}

export function getVenueComparisonString(venue: {
  name: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const parts: string[] = [];
  if (venue.name) parts.push(venue.name);
  if (venue.city) parts.push(venue.city);
  if (venue.state) parts.push(venue.state);
  return parts.join(" ") || "unknown";
}

export function getEventComparisonString(event: {
  name: string | null;
  venue?: { name: string | null } | null;
  startDate?: Date | string | null;
}): string {
  const parts: string[] = [];
  if (event.name) parts.push(event.name);
  if (event.venue?.name) parts.push(event.venue.name);
  if (event.startDate) {
    const date = new Date(event.startDate);
    if (!isNaN(date.getTime())) {
      parts.push(date.getFullYear().toString());
    }
  }
  return parts.join(" ") || "unknown";
}

export function getVendorComparisonString(vendor: {
  businessName: string | null;
  vendorType?: string | null;
}): string {
  const parts: string[] = [];
  if (vendor.businessName) parts.push(vendor.businessName);
  if (vendor.vendorType) parts.push(vendor.vendorType);
  return parts.join(" ") || "unknown";
}

export function getPromoterComparisonString(promoter: { companyName: string | null }): string {
  return promoter.companyName || "unknown";
}
