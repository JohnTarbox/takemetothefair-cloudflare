// Vendors whose description text contains gambling-spam patterns indicating
// the source website was hijacked (vendor's legitimate domain taken over by
// gambling/casino spam, then ingested into our DB by the AI enrichment
// pipeline). The doc's §3.5 lists Lord Hobo and Hop Meadow as known cases.
//
// Detection here is on TEXT CONTENT, not on a live website fetch — we
// pattern-match the description we already have in D1. This catches cases
// where bad content was already absorbed. Future extension: actively probe
// the vendor's website periodically (would need a sweep endpoint and
// outbound HTTP allowlist on the worker). For now the pattern-match form
// catches the visible damage.

import { sql, isNotNull } from "drizzle-orm";
import { vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

// Known gambling/casino spam terms. Each entry is a SQL `LIKE %like%`
// prefilter PLUS an optional JS `refine` regex that must also match for the
// row to count. Multi-stage filter keeps the SQL selective while letting JS
// enforce word boundaries / brand-suffix requirements that D1 can't reliably
// express.
//
// History: bare `"baki"` matched the substring inside `baking` / `bakery` /
// `bakeries`, flagging 8 legitimate Maine bakeries on 2026-05-12. Real
// gambling-affiliate spam always brands the token (BAKI77, BAKI88, BakiSlot,
// BakiGacor). The refine regex codifies that — bare `baki` is no longer a
// match; only `\bbaki<digits|known-suffix>\b` is.
//
// The other terms are multi-word phrases ("slot demo", "judi online", etc.)
// — their natural word boundaries already prevent the BAKI-style false
// positives, so no refine regex is needed.
const SPAM_TERMS: Array<{ like: string; refine?: RegExp }> = [
  { like: "baki", refine: /\bbaki(?:\d+|slot|gacor|togel|maxwin)\b/i },
  { like: "gacor" },
  { like: "slot demo" },
  { like: "judi online" },
  { like: "togel" },
  { like: "rtp slot" },
  { like: "slot pulsa" },
  { like: "situs slot" },
  { like: "akun pro" },
];

/**
 * Test exposure: returns true iff `description` matches any spam term per
 * the same two-stage filter the rule uses at runtime. Kept narrow so tests
 * can assert on the predicate directly without spinning up a D1 fixture.
 */
export function isHijackedDescription(description: string): boolean {
  const lower = description.toLowerCase();
  return SPAM_TERMS.some((t) => {
    if (!lower.includes(t.like)) return false;
    if (t.refine && !t.refine.test(description)) return false;
    return true;
  });
}

export const hijackedDomainDetectionRule: RuleDefinition = {
  ruleKey: "hijacked_domain_detection",
  title: "Vendors with gambling-spam patterns in description (likely hijacked source domain)",
  rationaleTemplate:
    "{n} vendor descriptions contain known gambling/casino spam patterns (BAKI77, gacor, slot demo, etc.). The source website was likely hijacked between when we last enriched it and now. Manual review needed — verify the website, mark domain_hijacked if confirmed, scrub the description.",
  severity: "red",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    if (SPAM_TERMS.length === 0) return [];
    // SQL prefilter: any LIKE %like% on a non-deleted vendor with a non-null
    // description. JS refines below to enforce word-boundary / brand-suffix
    // requirements.
    // eslint-disable-next-line no-restricted-syntax -- empty-safe: SPAM_TERMS is a non-empty hardcoded literal (+ length===0 early-return guard) (SQL OR-reducer, no neutral initial fragment)
    const termClauses = SPAM_TERMS.map(
      (t) => sql`LOWER(${vendors.description}) LIKE ${"%" + t.like.toLowerCase() + "%"}`
    ).reduce((acc, c) => sql`${acc} OR ${c}`);

    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        website: vendors.website,
        description: vendors.description,
      })
      .from(vendors)
      .where(
        sql`${isNotNull(vendors.description)} AND ${vendors.deletedAt} IS NULL AND (${termClauses})`
      );

    return rows
      .filter((r) => r.description && isHijackedDescription(r.description))
      .map((r) => ({
        targetType: "vendor",
        targetId: r.id,
        payload: {
          businessName: r.businessName,
          slug: r.slug,
          website: r.website,
        },
      }));
  },
};
