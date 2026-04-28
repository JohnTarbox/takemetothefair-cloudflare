import { EVENT_CATEGORIES } from "@/lib/constants";

type EventCategory = (typeof EVENT_CATEGORIES)[number];

// High-confidence keyword → canonical category mappings. Only multi-word
// phrases that are unambiguous in event names; generic words like "festival"
// alone are intentionally excluded to avoid false positives.
const NAME_PATTERNS: ReadonlyArray<readonly [RegExp, EventCategory]> = [
  [/farmer'?s?'?\s+market\b/i, "Farmers Market"],
  [/\bflea\s+market\b/i, "Flea Market"],
  [/\bcraft\s+fair\b/i, "Craft Fair"],
  [/\bcraft\s+show\b/i, "Craft Show"],
  [/\bcar\s+show\b/i, "Car Show"],
  [/\bantique\s+show\b/i, "Antique Show"],
  [/\btrade\s+show\b/i, "Trade Show"],
  [/\bhome\s+show\b/i, "Home Show"],
  [/\bagricultural\s+fair\b/i, "Agricultural Fair"],
  [/\bmusic\s+(festival|fest)\b/i, "Music Festival"],
  [/\bfood\s+(festival|fest)\b/i, "Food Festival"],
  [/\bholiday\s+market\b/i, "Holiday Market"],
  [/\bart\s+walk\b/i, "Art Walk"],
  [/\bfiber\s+arts?\b/i, "Fiber Arts Festival"],
];

/**
 * Infer canonical categories from an event name when the AI extractor
 * returned none. Returns null if no high-confidence keyword match is found,
 * letting callers fall back to their own placeholder.
 */
export function inferCategoriesFromName(name: string | null | undefined): string[] | null {
  if (!name) return null;
  const matches: string[] = [];
  for (const [pattern, category] of NAME_PATTERNS) {
    if (pattern.test(name) && !matches.includes(category)) {
      matches.push(category);
    }
  }
  return matches.length > 0 ? matches : null;
}
