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

// Known gambling/casino spam terms observed in hijacked-domain content per
// memory feedback_ai_category_fallback.md. Keep this list narrow — false
// positives on legitimate brewery / gaming-themed events would be costly.
const SPAM_TERMS = [
  "BAKI",
  "gacor",
  "slot demo",
  "judi online",
  "togel",
  "rtp slot",
  "slot pulsa",
  "situs slot",
  "akun pro",
];

export const hijackedDomainDetectionRule: RuleDefinition = {
  ruleKey: "hijacked_domain_detection",
  title: "Vendors with gambling-spam patterns in description (likely hijacked source domain)",
  rationaleTemplate:
    "{n} vendor descriptions contain known gambling/casino spam patterns (BAKI, gacor, slot demo, etc.). The source website was likely hijacked between when we last enriched it and now. Manual review needed — verify the website, mark domain_hijacked if confirmed, scrub the description.",
  severity: "red",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Build OR predicate for any spam term in description (case-insensitive
    // via LOWER). Skip this rule if SPAM_TERMS is empty.
    if (SPAM_TERMS.length === 0) return [];
    const termClauses = SPAM_TERMS.map(
      (t) => sql`LOWER(${vendors.description}) LIKE ${"%" + t.toLowerCase() + "%"}`
    ).reduce((acc, c) => sql`${acc} OR ${c}`);

    const rows = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        website: vendors.website,
      })
      .from(vendors)
      .where(
        sql`${isNotNull(vendors.description)} AND ${vendors.deletedAt} IS NULL AND (${termClauses})`
      );

    return rows.map((r) => ({
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
