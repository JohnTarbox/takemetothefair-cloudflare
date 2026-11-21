/**
 * OPE-1695 — words a booth sign says that are not a business name.
 *
 * Specimen (2026-11-20, CMP Employee Club Vendor & Craft Fair): a booth with a
 * "Welcome" sign became vendor "Welcome", products ["Welcome","Welcome"],
 * published CONFIRMED at confidence 1.0. The model read the sign correctly.
 * Nothing asked whether what it read was a name.
 *
 * ONE list, here. To extend it, add the lowercase word or phrase. A name is
 * generic only when EVERY part of it is on the list, so "Welcome Home Candles"
 * and "Open Hearth Pottery" are names and "Welcome" / "Handmade Gifts" /
 * "Cash Only" are not.
 */

/** Multi-word sign phrases, matched as whole phrases before single words. */
export const GENERIC_SIGN_PHRASES: readonly string[] = [
  "thank you",
  "thanks for stopping by",
  "cash only",
  "card accepted",
  "cards accepted",
  "credit cards accepted",
  "we accept",
  "shop small",
  "shop local",
  "buy local",
  "made in maine",
  "happy holidays",
  "merry christmas",
  "happy new year",
  "happy thanksgiving",
  "happy easter",
  "happy halloween",
  "season's greetings",
  "seasons greetings",
  "come in",
  "please touch",
  "please do not touch",
  "all sales final",
  "on sale",
  "for sale",
  "best seller",
  "free gift",
  "gift cards",
];

/** Single sign words. Any name made only of these (and filler) is generic. */
export const GENERIC_SIGN_WORDS: readonly string[] = [
  // the ticket's list
  "welcome",
  "sale",
  "open",
  "closed",
  "handmade",
  "homemade",
  "local",
  "crafts",
  "craft",
  "gifts",
  "gift",
  "thanks",
  "cash",
  "card",
  "cards",
  "venmo",
  "paypal",
  "zelle",
  "cashapp",
  "prices",
  "price",
  "each",
  "free",
  "new",
  "hello",
  "hi",
  "booth",
  "vendor",
  "vendors",
  "raffle",
  // payment / pricing signage
  "credit",
  "debit",
  "accepted",
  "only",
  "sold",
  "discount",
  "special",
  "specials",
  "off",
  "%",
  "buy",
  "get",
  "sample",
  "samples",
  "tasting",
  // months
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  // holidays / seasons
  "christmas",
  "xmas",
  "holiday",
  "holidays",
  "thanksgiving",
  "halloween",
  "easter",
  "valentine",
  "valentines",
  "hanukkah",
  "spring",
  "summer",
  "fall",
  "autumn",
  "winter",
  // filler that never makes a sign a name on its own
  "the",
  "a",
  "an",
  "and",
  "or",
  "&",
  "with",
  "in",
  "at",
  "is",
  "of",
  "for",
  "to",
  "here",
  "our",
  "we",
  "you",
  "your",
  "all",
  "now",
  "please",
  "!",
];

const WORDS = new Set(GENERIC_SIGN_WORDS);
// Longest first, so "thanks for stopping by" goes before a shorter overlap.
const PHRASES = [...GENERIC_SIGN_PHRASES].sort((a, b) => b.length - a.length);

/** Lowercase, curly quotes folded, punctuation other than & and % to spaces. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'&%!\s]/g, " ")
    .replace(/!/g, " ! ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the name is ONLY generic sign text. Pure.
 * Numbers count as generic too ("$5 each" → "5 each").
 */
export function isGenericSignName(name: string | null | undefined): boolean {
  let s = ` ${fold(name ?? "")} `;
  if (!s.trim()) return false;
  for (const p of PHRASES) s = s.split(` ${p} `).join(" ");
  const tokens = s.trim().split(" ").filter(Boolean);
  return tokens.every((t) => WORDS.has(t) || /^\d+$/.test(t));
}

/**
 * True when the extracted products list just repeats the name: every product,
 * folded, IS the name (["Welcome","Welcome"] for "Welcome"). An empty list is
 * not an echo, just absent. Pure.
 */
export function isProductEcho(
  name: string | null | undefined,
  products: readonly string[]
): boolean {
  const n = fold(name ?? "");
  if (!n || products.length === 0) return false;
  return products.every((p) => fold(p) === n);
}

/** Products that say something beyond the name: non-empty and not an echo. */
export function hasIndependentProducts(
  name: string | null | undefined,
  products: readonly string[]
): boolean {
  return products.some((p) => fold(p) !== "" && fold(p) !== fold(name ?? ""));
}
