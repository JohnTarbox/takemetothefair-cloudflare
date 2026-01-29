/**
 * Similarity calculation utilities for duplicate detection
 * Uses Normalized Levenshtein distance + Jaccard similarity
 */

/**
 * Normalize a string for comparison
 * - Convert to lowercase
 * - Remove special characters
 * - Trim whitespace
 */
export function normalizeString(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 * @returns The number of single-character edits needed to transform a into b
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  // Initialize first column
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  // Initialize first row
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate normalized Levenshtein similarity (0-1)
 * 1 = identical, 0 = completely different
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const normalizedA = normalizeString(a);
  const normalizedB = normalizeString(b);

  if (normalizedA === normalizedB) return 1;
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;

  const distance = levenshteinDistance(normalizedA, normalizedB);
  const maxLength = Math.max(normalizedA.length, normalizedB.length);

  return 1 - distance / maxLength;
}

/**
 * Tokenize a string into words
 */
export function tokenize(str: string): Set<string> {
  const normalized = normalizeString(str);
  const tokens = normalized.split(" ").filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Calculate Jaccard similarity between two sets
 * |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  const aArray = Array.from(a);
  const bArray = Array.from(b);
  const intersection = new Set(aArray.filter((x) => b.has(x)));
  const union = new Set(aArray.concat(bArray));

  return intersection.size / union.size;
}

/**
 * Calculate token-based Jaccard similarity for two strings
 */
export function tokenJaccardSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  return jaccardSimilarity(tokensA, tokensB);
}

/**
 * Calculate combined similarity score
 * Weighted average of Levenshtein and Jaccard similarities
 * @param levenshteinWeight Weight for Levenshtein (default 0.6)
 */
export function combinedSimilarity(
  a: string,
  b: string,
  levenshteinWeight: number = 0.6
): number {
  const levSim = levenshteinSimilarity(a, b);
  const jacSim = tokenJaccardSimilarity(a, b);

  return levSim * levenshteinWeight + jacSim * (1 - levenshteinWeight);
}

/**
 * Find all pairs of entities that exceed the similarity threshold
 * @param getExactMatchKey Optional function that returns a key for exact-match detection
 *   (e.g. Google Place ID). When two entities share the same non-empty key,
 *   their similarity is set to 0.99 regardless of text similarity.
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
      // Check for exact match key (e.g. same Google Place ID)
      let similarity: number;
      const key1 = getExactMatchKey?.(entities[i]);
      const key2 = getExactMatchKey?.(entities[j]);
      if (key1 && key2 && key1 === key2) {
        similarity = 0.99;
      } else {
        const str1 = getComparisonString(entities[i]);
        const str2 = getComparisonString(entities[j]);
        similarity = combinedSimilarity(str1, str2);
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

  // Sort by similarity descending
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Get comparison string for venue entity
 */
export function getVenueComparisonString(venue: {
  name: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  // Combine name with location for better matching
  const parts: string[] = [];
  if (venue.name) parts.push(venue.name);
  if (venue.city) parts.push(venue.city);
  if (venue.state) parts.push(venue.state);
  return parts.join(" ") || "unknown";
}

/**
 * Get comparison string for event entity
 */
export function getEventComparisonString(event: {
  name: string | null;
  venue?: { name: string | null } | null;
  startDate?: Date | string | null;
}): string {
  const parts: string[] = [];
  if (event.name) parts.push(event.name);
  if (event.venue?.name) parts.push(event.venue.name);
  // Include year to distinguish recurring events
  if (event.startDate) {
    const date = new Date(event.startDate);
    if (!isNaN(date.getTime())) {
      parts.push(date.getFullYear().toString());
    }
  }
  return parts.join(" ") || "unknown";
}

/**
 * Get comparison string for vendor entity
 */
export function getVendorComparisonString(vendor: {
  businessName: string | null;
  vendorType?: string | null;
}): string {
  const parts: string[] = [];
  if (vendor.businessName) parts.push(vendor.businessName);
  if (vendor.vendorType) parts.push(vendor.vendorType);
  return parts.join(" ") || "unknown";
}

/**
 * Get comparison string for promoter entity
 */
export function getPromoterComparisonString(promoter: {
  companyName: string | null;
}): string {
  return promoter.companyName || "unknown";
}
