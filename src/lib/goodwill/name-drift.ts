/**
 * OPE-1270 — does a business's own website still call it what we call it?
 *
 * A 20-row random sample of vendors found 3 stale names (15%): Bay State
 * Savings Bank (now "Bay State Bank", old domain 302s to the new one),
 * Promethea Potters (now "Promethea Arts"), Premier Generator (now "Premier
 * Energy Solutions Inc."). Nothing in the estate would ever have noticed.
 *
 * ## What counts as the site's own name
 *
 * Only what the site DECLARES about itself in JSON-LD: `name` and `legalName`
 * on an Organization / LocalBusiness / Corporation / *Store / *Business node,
 * including inside `@graph`. Not the `<title>`, not headings, not review text —
 * "Premier Generator" appears informally all over that site's prose, which is
 * exactly why prose is not evidence of what a business calls itself.
 *
 * No declaration → `null` (unknown), never "no drift". Absence of a JSON-LD
 * name is not evidence the name still matches.
 *
 * ## Normalisation — the false mismatches this must NOT raise
 *
 * Confirmed same-entity in the same sample, and pinned in the tests:
 *   W.E. Brown Roofing ↔ WE Brown Roofing
 *   H.G. Johnson ↔ HG Johnson
 *   Ye Olde Pepper Candy Companie, LTD ↔ Ye Olde Pepper Candy Companie
 *   Laiken Mae Handmade ↔ Laiken Mae Hand Made
 * Hence: punctuation out, `&` → `and`, trailing legal suffixes out, and the
 * comparison is on the SPACE-FREE form so "Hand Made" equals "Handmade".
 * One name containing the other also counts as a match ("Joe's Pottery" vs
 * "Joe's Pottery Studio") — a longer trading name is not a rebrand.
 *
 * This only ever DETECTS. It never renames (the ticket's STOP: a rename moves a
 * public URL, and OPE-495 / OPE-1183 show renames orphan slugs).
 */

import { createSlug } from "@takemetothefair/utils";

const ORG_TYPE_RE = /(organization|corporation|business|store|shop|bank|restaurant|brand)$/i;

/**
 * schema.org has ~200 LocalBusiness subtypes (BankOrCreditUnion, Electrician,
 * Bakery, Florist…) and most do not end in a word the regex above can know.
 * So a node also counts when it carries business-identity properties — and is
 * not one of the types that ALSO carry them without being the business.
 */
const BUSINESS_PROPS = [
  "address",
  "telephone",
  "openingHours",
  "openingHoursSpecification",
  "priceRange",
];
const NOT_THE_BUSINESS_RE =
  /^(person|event|place|postaladdress|contactpoint|website|webpage|offer|product|review)$/i;

function isOrganizationNode(node: Record<string, unknown>): boolean {
  const types = typesOf(node);
  if (types.some((t) => ORG_TYPE_RE.test(t))) return true;
  if (types.length === 0 || types.some((t) => NOT_THE_BUSINESS_RE.test(t))) return false;
  return BUSINESS_PROPS.some((k) => node[k] != null);
}

/** Legal-form words dropped from the END of a name, repeatedly. */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "lp",
  "llp",
  "pllc",
  "pc",
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#0*39;|&apos;|&#x0*27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Lower-case, `&`→and, punctuation out, legal suffixes off the end. Spaced. */
export function normalizeBusinessName(name: string): string {
  // createSlug is the canonical normaliser (#120): & → "and", apostrophes
  // dropped cleanly, accents transliterated. Dots are joined first so "W.E."
  // reads "we". For MATCHING the dot rule is redundant — the comparison below
  // is on the space-free form, so "w e" and "we" are equal anyway (a mutation
  // removing it stays green, verified) — it keeps the spaced form readable.
  const words = String(createSlug(decodeEntities(name).replace(/\./g, "")))
    .split("-")
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

const compact = (s: string) => normalizeBusinessName(s).replace(/ /g, "");

/** True when two names denote the same business under the rules above. */
export function sameBusinessName(a: string, b: string): boolean {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Containment, but only of a substantial name — "co" is inside everything.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  out.push(node);
  if (node["@graph"]) collectNodes(node["@graph"], out);
}

/** Every `name` / `legalName` the page declares for an organization-type node. */
export function declaredOrganizationNames(html: string | null): string[] {
  if (!html) return [];
  const names = new Set<string>();
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // a broken block on a vendor's site is their problem, not a signal
    }
    const nodes: Record<string, unknown>[] = [];
    collectNodes(parsed, nodes);
    for (const node of nodes) {
      if (!isOrganizationNode(node)) continue;
      for (const key of ["name", "legalName"]) {
        const v = node[key];
        if (typeof v === "string" && v.trim()) names.add(decodeEntities(v.trim()));
      }
    }
  }
  return [...names];
}

export interface NameDrift {
  /** true = drifted, false = the site's name matches ours, null = unknown. */
  drift: boolean | null;
  /** The site's declared name(s) — evidence for the operator. */
  declared: string[];
}

/**
 * Drift = the site declares at least one organization name and NONE of them is
 * the same business name as ours.
 */
export function detectNameDrift(ourName: string | null, html: string | null): NameDrift {
  const declared = declaredOrganizationNames(html);
  if (!ourName?.trim() || declared.length === 0) return { drift: null, declared };
  return { drift: !declared.some((d) => sameBusinessName(ourName, d)), declared };
}
