/**
 * Enhanced Profile renewal reminders. Split into three rules by urgency so the
 * UI's severity grouping (red / yellow / blue) maps cleanly without per-item
 * severity overrides:
 *   - critical: ≤ 7 days until expiry  (red — revenue at imminent risk)
 *   - warning:  8–14 days until expiry (yellow — schedule renewal)
 *   - notice:   15–30 days until expiry (blue — heads up)
 *
 * Time math: vendors.enhancedProfileExpiresAt is Drizzle mode:"timestamp"
 * (ms-epoch). Compare with `new Date(now + Nd*86400000)` not `unixepoch()`.
 */

import { and, eq, gt, lte } from "drizzle-orm";
import { vendors } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const RESULT_LIMIT = 50;

function buildRule(
  ruleKey: string,
  title: string,
  rationaleTemplate: string,
  severity: "red" | "yellow" | "blue",
  minDays: number,
  maxDays: number
): RuleDefinition {
  return {
    ruleKey,
    title,
    rationaleTemplate,
    severity,
    category: "revenue",
    async run(db): Promise<ItemMatch[]> {
      const now = Date.now();
      // minDays..maxDays from now (inclusive). Bucket boundaries are picked so
      // critical(0..7) + warning(8..14) + notice(15..30) tile cleanly.
      const minExpiry = new Date(now + minDays * 86400 * 1000);
      const maxExpiry = new Date(now + (maxDays + 1) * 86400 * 1000);

      const rows = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          expiresAt: vendors.enhancedProfileExpiresAt,
        })
        .from(vendors)
        .where(
          and(
            eq(vendors.enhancedProfile, true),
            gt(vendors.enhancedProfileExpiresAt, minExpiry),
            lte(vendors.enhancedProfileExpiresAt, maxExpiry)
          )
        )
        .limit(RESULT_LIMIT);

      return rows.map((r) => {
        const daysUntil = r.expiresAt
          ? Math.max(0, Math.ceil((r.expiresAt.getTime() - now) / 86400_000))
          : null;
        return {
          targetType: "vendor",
          targetId: r.id,
          payload: {
            businessName: r.businessName,
            slug: r.slug,
            expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
            daysUntil,
          },
        };
      });
    },
  };
}

export const enhancedProfileRenewalCriticalRule = buildRule(
  "enhanced_profile_renewal_critical",
  "Enhanced Profile expiring in ≤7 days",
  "{n} paying vendor(s) need renewal this week.",
  "red",
  0,
  7
);

export const enhancedProfileRenewalWarningRule = buildRule(
  "enhanced_profile_renewal_warning",
  "Enhanced Profile expiring in 8–14 days",
  "{n} paying vendor(s) need renewal soon.",
  "yellow",
  8,
  14
);

export const enhancedProfileRenewalNoticeRule = buildRule(
  "enhanced_profile_renewal_notice",
  "Enhanced Profile expiring in 15–30 days",
  "{n} paying vendor(s) have renewal coming up.",
  "blue",
  15,
  30
);
