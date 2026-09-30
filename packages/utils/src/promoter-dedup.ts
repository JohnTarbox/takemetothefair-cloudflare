import { registrableDomain } from "./page-crawl";
// ⚠️ createSlug lives in index.ts, which also re-exports this module — a
// deliberate cycle. It is safe because `createSlug` is a hoisted function
// DECLARATION and is only called at runtime, never during module
// initialisation, so neither module needs the other to be fully evaluated at
// import time. Verified by tsc, both vitest suites, and the OpenNext bundle.
// If createSlug is ever changed to a const arrow function, this breaks — move
// it to its own module rather than working around it here.
import { createSlug } from "./index";

/**
 * OPE-858 — warn-only duplicate advisory for promoters.
 *
 * ## What was actually there (the ticket's own pre-flight, run)
 *
 * The ticket says `create_promoter` has "no duplicate detection of any kind".
 * That is **not quite right**, and it asked to be checked:
 *
 *   - The MCP tool DOES have one — an EXACT `company_name` match that
 *     **refuses** the create (`mcp-server/src/tools/admin.ts`).
 *   - The admin route `POST /api/admin/promoters` has **nothing**.
 *
 * Exact-match is why every specimen got through: `Craftah LLC` and
 * `Craftah, LLC` differ by one comma, so the existing check saw two different
 * names and waved the second one in. The evidence in the ticket is right; only
 * the "no detection at all" framing was wrong.
 *
 * ## Why this WARNS and never blocks
 *
 * Measured over all 748 promoters, a naive rule returns **more false positives
 * than true ones**. These must never be fused:
 *
 *   - `facebook.com` — 4 unrelated organisations using a Facebook page as their
 *     website.
 *   - `e-clubhouse.org` — 2 genuinely different Lions clubs on the shared Lions
 *     International platform.
 *   - `Washington County Fair` (Pembroke, ME) vs `Washington County Fair
 *     Association` (Richmond, RI) — identical name root, two real and different
 *     fairs. The `+ state` half of axis 2 is the only thing that saves this,
 *     which is why it is mandatory rather than a refinement.
 *   - `Paragon Group, Inc.` vs `RV Supershows` — parent producer and brand on
 *     one domain. A judgment call, not a duplicate.
 *
 * ## ⚠️ Stated benefit cap — this is not a general solution
 *
 * Neither axis catches OPE-822's own pair: `New England Home Show`
 * (`nehomeshow.com`, RI) and `New England Home Shows`
 * (`newenglandhomeshows.com`, MA) differ in BOTH domain and state. This is
 * built for the Craftah class. Saying so here matters more than it looks: the
 * next reader will otherwise assume promoter duplicates are now handled.
 */

/**
 * Hosts where a shared domain means "same platform", never "same company".
 *
 * A named constant rather than an inline literal because the false-positive
 * cost is asymmetric: a missing entry silently fuses two unrelated
 * organisations in an operator's mind, and the operator has no way to see that
 * the domain was shared infrastructure.
 */
export const PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
  "facebook.com",
  "fb.com",
  "e-clubhouse.org",
  "linktr.ee",
  "instagram.com",
  "sites.google.com",
  "google.com",
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "weebly.com",
  "blogspot.com",
  "wordpress.com",
  "eventbrite.com",
  "meetup.com",
  "godaddysites.com",
]);

/**
 * The registrable domain (eTLD+1) of a URL or bare host.
 *
 * `www.craftah.com` and `events.craftah.com` must both yield `craftah.com` —
 * that pair is the whole reason axis 1 keys on eTLD+1 rather than the full
 * host, and it is the case the ticket's design driver turns on.
 *
 * ⚠️ The suffix logic is NOT reimplemented here. `registrableDomain` in
 * page-crawl.ts already owns the multi-label public-suffix table, and a second
 * copy is how the two stop agreeing about `co.uk` — the identical failure mode
 * OPE-862 fixed one level up for send gates. This adds only the part that was
 * missing: `promoters.website` holds URLs *and* bare hosts, and the existing
 * helper takes a host.
 *
 * Returns null for anything unparseable, which the caller treats as "no domain
 * evidence" rather than as a match.
 */
export function websiteRegistrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = `https://${host}`;
  try {
    host = new URL(host).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (!host || host === "localhost" || !host.includes(".")) return null;
  return registrableDomain(host);
}

/** True when a domain is shared infrastructure, so sharing it proves nothing. */
export function isPlatformDomain(domain: string | null): boolean {
  return !!domain && PLATFORM_DOMAINS.has(domain);
}

/**
 * Corporate-form words that carry no identity.
 *
 * `Craftah LLC` / `Craftah, LLC` differ only by punctuation; `North Stonington
 * Agricultural Fair Inc` / `… Association` differ only by the form word. Both
 * pairs are real duplicates in production.
 */
const FORM_WORDS = [
  "incorporated",
  "inc",
  "llc",
  "l.l.c",
  "ltd",
  "corp",
  "corporation",
  "co",
  "company",
  "association",
  "assoc",
  "assn",
  "society",
  "committee",
  "group",
  "productions",
  "production",
  "events",
  "event",
];

/**
 * Reduce a promoter name to its identity root.
 *
 * Casefold, strip punctuation, drop a leading "the", drop trailing corporate
 * form words, and singularise a trailing "s" on the remaining root.
 *
 * ⚠️ The trailing-`s` rule is why `New England Home Show` and `New England Home
 * Shows` share a root — and they are NOT duplicates (OPE-822: different
 * domains, different states). That is fine precisely because axis 2 also
 * requires equal `state`, and they differ. It is a good illustration of why the
 * state requirement is load-bearing rather than decorative.
 */
export function normalizePromoterRoot(name: string | null | undefined): string {
  if (!name) return "";

  // ⚠️ Tokenise via createSlug rather than a hand-rolled character class.
  //
  // My first version used an inline `/[^a-z0-9]+/` and ESLint's
  // no-restricted-syntax rule (the #120 slug-divergence guard) rejected it —
  // correctly, and the rejection improved the code. `createSlug` expands
  // `&` to "and", drops apostrophes cleanly and transliterates accented
  // characters; the naive class does none of that, which means
  // `Smith & Sons` and `Smith and Sons` would have compared as DIFFERENT
  // organisations. That is the same class of miss this whole module exists to
  // catch.
  //
  // Nothing here is ever stored in a slug column — this is a comparison key —
  // but reusing the canonical tokeniser means the dedup key and the URL key
  // can never disagree about what a name's words are.
  let words = createSlug(name).split("-").filter(Boolean);
  if (words.length === 0) return "";

  if (words.length > 1 && words[0] === "the") words = words.slice(1);

  // Drop form words from the END only. "Event Group of Maine" keeps its
  // identity; "Maine Event Group" loses a suffix that carries none.
  while (words.length > 1 && FORM_WORDS.includes(words[words.length - 1])) {
    words = words.slice(0, -1);
  }

  // Singularise the trailing token, but never down to nothing.
  const last = words[words.length - 1];
  if (last.length > 3 && last.endsWith("s")) words[words.length - 1] = last.slice(0, -1);

  return words.join(" ");
}

export interface PromoterCandidateRow {
  id: string;
  slug: string | null;
  companyName: string | null;
  website: string | null;
  state: string | null;
}

export interface PromoterDuplicateHit {
  id: string;
  slug: string | null;
  company_name: string | null;
  /** Which axis fired. Both when both did — the strongest possible signal. */
  matched_on: Array<"registrable_domain" | "name_root_and_state">;
  registrable_domain?: string;
  name_root?: string;
}

/**
 * Find advisory duplicate candidates for a promoter about to be created.
 *
 * PURE — the caller supplies the existing rows. That keeps the decision
 * testable against the real false-positive set without a database, and lets the
 * two intake paths (MCP tool, admin route) share one definition of "possible
 * duplicate" instead of drifting into two.
 *
 * ⚠️ NEVER returns a reason to refuse. There is no confidence score and no
 * threshold to tune into a gate. `suggest_event`'s blocking guard produced the
 * routine-`force_create` problem (OPE-454 / OPE-650); this deliberately has
 * nothing to override.
 */
export function findPromoterDuplicates(
  incoming: { name: string; website?: string | null; state?: string | null },
  existing: readonly PromoterCandidateRow[]
): PromoterDuplicateHit[] {
  const inDomain = websiteRegistrableDomain(incoming.website);
  const domainUsable = inDomain !== null && !isPlatformDomain(inDomain);

  const inRoot = normalizePromoterRoot(incoming.name);
  const inState = (incoming.state ?? "").trim().toUpperCase();

  const hits = new Map<string, PromoterDuplicateHit>();

  for (const row of existing) {
    const axes: PromoterDuplicateHit["matched_on"] = [];

    if (domainUsable) {
      const rowDomain = websiteRegistrableDomain(row.website);
      if (rowDomain && rowDomain === inDomain && !isPlatformDomain(rowDomain)) {
        axes.push("registrable_domain");
      }
    }

    // Axis 2 requires a state on BOTH sides. A missing state is not a match —
    // it is an absence of evidence, and treating it as agreement is how
    // Washington County Fair (ME) and Washington County Fair Association (RI)
    // would fuse.
    const rowState = (row.state ?? "").trim().toUpperCase();
    if (inRoot && inState && rowState && inState === rowState) {
      if (normalizePromoterRoot(row.companyName) === inRoot) {
        axes.push("name_root_and_state");
      }
    }

    if (axes.length === 0) continue;
    hits.set(row.id, {
      id: row.id,
      slug: row.slug,
      company_name: row.companyName,
      matched_on: axes,
      ...(axes.includes("registrable_domain") && inDomain ? { registrable_domain: inDomain } : {}),
      ...(axes.includes("name_root_and_state") ? { name_root: inRoot } : {}),
    });
  }

  return [...hits.values()];
}
