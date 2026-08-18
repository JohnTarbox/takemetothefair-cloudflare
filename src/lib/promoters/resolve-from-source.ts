/**
 * OPE-458 scope 3 — an event scraped from a promoter's own site should belong
 * to that promoter.
 *
 * Four events named "Vineyard Artisans …" were created from
 * `vineyardartisans.com` and assigned to `system-community-suggestions`, while a
 * promoter row literally called **Vineyard Artisans**
 * (`0b9f735f-77bc-465e-9364-1f8625a25c08`) sat in the database already owning
 * two of its other festivals.
 *
 * OPE-201 normalizes the VENUE on auto-created events and has since day one.
 * There has never been an equivalent for the promoter, so
 * `system-community-suggestions` is the default rather than the fallback. That
 * is not only untidy: as OPE-423 notes, orphaning events under the community
 * promoter is itself a duplicate-creation mechanism, because dedup then has no
 * promoter axis to key on.
 *
 * ── Why this is deliberately timid ────────────────────────────────────────
 *
 * Assigning an event to the WRONG promoter is worse than leaving it with the
 * community placeholder: it hands one organizer's listing to another, publishes
 * it on their page, and emits no signal that anything went wrong. Defaulting to
 * community is visibly incomplete; a wrong owner is invisibly incorrect. So
 * every rule here fails closed.
 *
 *   1. **Domain** — the event's source URL host equals the promoter's website
 *      host (`www.` stripped). Strong: the page we read it off IS theirs.
 *   2. **Name prefix** — the event name begins with the promoter's company name
 *      on a word boundary ("Vineyard Artisans Summer Festival" ⊃ "Vineyard
 *      Artisans"). Gated on the promoter name having **≥2 tokens and ≥8
 *      characters**, which excludes the 9 single-token and 2 short names among
 *      697 promoters — precisely the ones that would prefix-match half the
 *      catalog.
 *
 * A match must be **unique**. Two promoters matching means we cannot tell, and
 * guessing between them is the failure this exists to avoid, so an ambiguous
 * match returns null and the caller keeps the community placeholder.
 *
 * Fuzzy/similarity matching is intentionally absent. It is the right tool for
 * "are these the same event?", where a miss costs a duplicate. It is the wrong
 * tool for "who owns this?", where a miss costs someone else's listing.
 *
 * Note the specimen needs rule 2, not rule 1: those four events carry
 * `source_url = NULL` because they came off the body path (see OPE-457), so
 * there is no domain to match on. Shipping only the domain rule would have
 * looked principled and fixed nothing.
 */

import { ne } from "drizzle-orm";
import { normalizeVendorName } from "@takemetothefair/utils";
import type { Database } from "@/lib/db";
import { promoters } from "@/lib/db/schema";

/** The community placeholder every unresolved submission falls back to. */
export const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

const MIN_NAME_TOKENS = 2;
const MIN_NAME_CHARS = 8;

/** Host without `www.`, lowercased. Null when unparseable. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Comparison form. Delegates to the shared `normalizeVendorName`, which already
 * folds `&`↔"and", the Unicode dash family, HTML entities and trailing legal
 * forms — all common in promoter names ("Smith & Sons Productions LLC").
 *
 * Reused rather than hand-rolled for two reasons: the repo's #120 lint bans
 * inline `[^a-z0-9]+` chains precisely because they miss those cases, and
 * matching promoters through the same normalizer vendors use keeps the two
 * entity types from drifting apart.
 *
 * Both sides get identical treatment, so prefix comparison stays valid.
 */
function norm(s: string): string {
  return normalizeVendorName(s);
}

/** Is `promoterName` a whole-word prefix of `eventName`? */
export function isNamePrefixMatch(eventName: string, promoterName: string): boolean {
  const p = norm(promoterName);
  const e = norm(eventName);
  if (p.length < MIN_NAME_CHARS) return false;
  if (p.split(" ").length < MIN_NAME_TOKENS) return false;
  if (e === p) return true;
  // Word boundary: the next character must be a space, so "Vineyard Artisans"
  // matches "Vineyard Artisans Summer Festival" but not "Vineyard Artisanship".
  return e.startsWith(p + " ");
}

export interface ResolvedPromoter {
  promoterId: string;
  basis: "source_domain" | "name_prefix";
  promoterName: string;
}

/**
 * Find the promoter that owns this submission, or null to keep the community
 * placeholder. Read-only.
 */
export async function resolvePromoterForSource(
  db: Database,
  input: { sourceUrl?: string | null; eventName?: string | null }
): Promise<ResolvedPromoter | null> {
  const rows = await db
    .select({ id: promoters.id, companyName: promoters.companyName, website: promoters.website })
    .from(promoters)
    .where(ne(promoters.id, COMMUNITY_PROMOTER_ID));

  // 1. Domain.
  const srcHost = hostOf(input.sourceUrl);
  if (srcHost) {
    const domainHits = rows.filter((r) => r.website && hostOf(r.website) === srcHost);
    if (domainHits.length === 1) {
      return {
        promoterId: domainHits[0].id,
        basis: "source_domain",
        promoterName: domainHits[0].companyName,
      };
    }
    // 2+ promoters on one domain → ambiguous; fall through rather than pick.
  }

  // 2. Name prefix.
  const name = (input.eventName ?? "").trim();
  if (name.length > 0) {
    const nameHits = rows.filter((r) => r.companyName && isNamePrefixMatch(name, r.companyName));
    if (nameHits.length === 1) {
      return {
        promoterId: nameHits[0].id,
        basis: "name_prefix",
        promoterName: nameHits[0].companyName,
      };
    }
  }

  return null;
}
