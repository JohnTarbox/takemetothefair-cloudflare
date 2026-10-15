/**
 * OPE-962 / OPE-1279 — a promoter's APPLIABLE enrichment gap, as SQL.
 *
 * How many of the five fields a live render can actually auto-APPLY are empty:
 * description, contact_email, contact_phone, social_links, hero. `logo` is
 * excluded on purpose: its rule agreement is too low to auto-apply, so it
 * always stages for review and a logo-only gap is not work the drain can
 * finish. The description test mirrors isPlaceholderDescription
 * (@takemetothefair/constants): blank, or the auto-generated "…is an event
 * organizer" boilerplate.
 *
 * One definition shared by `list_promoter_enrichment_queue` (order_by gap /
 * min_gap) and the coverage route's gap distribution, so the drain's "queue
 * head full vs extractor failing" read uses the same number it selects on.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { promoters } from "./index";

const empty = (col: AnyColumn) =>
  sql`(CASE WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN 1 ELSE 0 END)`;

export function promoterAppliableGapSql(): SQL<number> {
  return sql<number>`(
    (CASE WHEN ${promoters.description} IS NULL OR TRIM(${promoters.description}) = ''
          OR LOWER(TRIM(${promoters.description})) IN ('event organizer', 'event organizer.')
          OR (LENGTH(TRIM(${promoters.description})) < 60
              AND LOWER(${promoters.description}) LIKE '%is an event organizer%')
     THEN 1 ELSE 0 END)
    + ${empty(promoters.contactEmail)}
    + ${empty(promoters.contactPhone)}
    + (CASE WHEN ${promoters.socialLinks} IS NULL
              OR TRIM(${promoters.socialLinks}) IN ('', '[]', '{}')
              OR LOWER(TRIM(${promoters.socialLinks})) = 'null'
       THEN 1 ELSE 0 END)
    + ${empty(promoters.heroImageUrl)}
  )`;
}
