/**
 * Venues whose description starts with "Duplicate of" — the soft-delete
 * marker convention used by the dedup tooling. They've been logically
 * retired (events reassigned to canonical venue, no public page consumes
 * them), but D1 hasn't actually run delete_venue on them.
 *
 * Surfacing this as a rule lets the admin notice the backlog and run the
 * hard delete via the MCP tool. As of 2026-05-03, only 1 such venue
 * exists in prod — but the analyst caught one that had been sitting for a
 * while, suggesting the pattern can quietly accumulate.
 */

import { like } from "drizzle-orm";
import { venues } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const softDeletedVenuesRule: RuleDefinition = {
  ruleKey: "soft_deleted_venues",
  title: "Venues marked 'Duplicate of …' but not yet hard-deleted",
  rationaleTemplate:
    "{n} venue(s) are flagged as duplicates but still in the venues table. Run the venue hard-delete (MCP tool delete_venue) to clean them up.",
  severity: "blue",
  category: "data_quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        description: venues.description,
      })
      .from(venues)
      .where(like(venues.description, "Duplicate of%"));

    return rows.map((r) => ({
      targetType: "venue",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        // First 80 chars of the marker description so the admin can see which
        // canonical venue the events were reassigned to.
        marker: r.description ? r.description.slice(0, 80) : null,
      },
    }));
  },
};
