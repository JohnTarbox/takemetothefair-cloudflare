/**
 * Slug-suffix duplicate detection. When two APPROVED events share the same
 * name + start_date but one has a `-1` or `-2` slug suffix, the suffixed row
 * is almost always a duplicate that slipped past the URL classification gate
 * (typically from aggregator imports — see project_url_classification memory
 * and the cluster of dupes John cleaned 2026-05-03).
 *
 * The slug-suffix logic itself works correctly: when an event with the same
 * name + date is being inserted twice, the second one gets a `-1` appended
 * to its slug to avoid a UNIQUE conflict. So the rule isn't catching a slug
 * generation bug — it's catching the upstream "we shouldn't have inserted
 * this row at all" data-quality issue.
 *
 * Self-join: same table aliased twice. The `length(b.slug) < length(a.slug)`
 * predicate ensures `a` is the suffixed row (longer slug) and `b` is the
 * canonical row (shorter slug); we surface `a` for cleanup with `b`'s slug
 * displayed as the canonical reference.
 *
 * Recurring annual events (e.g. "Bass Park After Dark x3") legitimately use
 * `-1` / `-2` suffixes when they have different start_dates — those don't
 * match this rule because the join requires same start_date.
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { events } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const slugSuffixDuplicatesRule: RuleDefinition = {
  ruleKey: "slug_suffix_duplicates",
  title: "APPROVED events with slug-suffix duplicates",
  rationaleTemplate:
    "{n} APPROVED events share name + start date with another event but have a -1/-2 slug suffix. Almost certainly aggregator-import duplicates — review and reject the suffixed copy.",
  severity: "yellow",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const a = alias(events, "a");
    const b = alias(events, "b");

    const rows = await db
      .select({
        id: a.id,
        name: a.name,
        slug: a.slug,
        canonicalSlug: b.slug,
      })
      .from(a)
      .innerJoin(
        b,
        and(
          eq(b.name, a.name),
          eq(b.startDate, a.startDate),
          ne(b.id, a.id),
          sql`LENGTH(${b.slug}) < LENGTH(${a.slug})`,
          eq(b.status, "APPROVED")
        )
      )
      .where(and(sql`${a.slug} GLOB '*-[12]'`, eq(a.status, "APPROVED")));

    // De-duplicate by suffixed-event id: a single suffixed event might join
    // against multiple canonical rows (rare, but possible for triple-imports).
    // Surface each suffixed event once.
    const byId = new Map<string, { name: string; slug: string; canonicalSlug: string }>();
    for (const r of rows) {
      if (!byId.has(r.id)) {
        byId.set(r.id, { name: r.name, slug: r.slug, canonicalSlug: r.canonicalSlug });
      }
    }

    return Array.from(byId.entries()).map(([id, r]) => ({
      targetType: "event",
      targetId: id,
      payload: {
        name: r.name,
        slug: r.slug,
        canonicalSlug: r.canonicalSlug,
      },
    }));
  },
};
