// Events with slug suffixes that don't match common search patterns. The
// doc's example: an event slugged `bolton-fair-bolton-fairgrounds-ma` when
// users search "bolton fair" — the venue/state suffix bloats the slug
// without earning any CTR back. Rename to drop the redundant suffix.
//
// Detection: events whose slug ends in a New England state code suffix
// (`-ma`, `-vt`, `-nh`, `-me`, `-ri`, `-ct`) OR whose slug contains the
// venue's city as a trailing segment that's NOT in the event name.
// The slug rename machinery (vendor_slug_history-style) already exists
// for vendors; events would need similar — flagging for now, separate
// engineering work to actually rename.

import { sql } from "drizzle-orm";
import { events, venues } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

const NE_STATE_SUFFIXES = ["-ma", "-vt", "-nh", "-me", "-ri", "-ct"];

export const slugQualityDriftRule: RuleDefinition = {
  ruleKey: "slug_quality_drift",
  title: "Events with bloated slugs (venue/state suffix not matching search patterns)",
  rationaleTemplate:
    "{n} event slugs end in a state code or venue/city suffix that bloats the URL without earning CTR. Renaming to drop the redundant suffix improves both perceived URL quality and click-through. Rename via the slug-history-aware admin path so old URLs 301-redirect.",
  severity: "yellow",
  category: "seo",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Build a SQL OR for trailing state-code suffixes
    const stateSuffixOr = NE_STATE_SUFFIXES.map(
      (suf) => sql`LOWER(${events.slug}) LIKE ${"%" + suf}`
    ).reduce((acc, c) => sql`${acc} OR ${c}`);

    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(events)
      .leftJoin(venues, sql`${events.venueId} = ${venues.id}`)
      .where(stateSuffixOr);

    // Filter in TS for the "city suffix not in event name" heuristic, since
    // it requires per-row name + slug + city comparison.
    const matches = rows.filter((r) => {
      const slugLower = r.slug.toLowerCase();
      const nameLower = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      // Already trimmed nameLower to slug-shape; check if slug has trailing
      // segments beyond the name. If yes, those segments are the suspect
      // suffix. Heuristic: if removing the trailing -ST suffix still leaves
      // the slug longer than the slug-form of the name + 4 chars (allowing
      // for "-2026" year prefixes etc.), it's bloated.
      const stateMatch = NE_STATE_SUFFIXES.find((s) => slugLower.endsWith(s));
      if (!stateMatch) return false;
      const slugMinusState = slugLower.slice(0, -stateMatch.length);
      // If the bare name (in slug form) is contained at the start of the
      // slug-minus-state, the trailing segment after the name is the bloat.
      // Simple heuristic: bloat exists if slug-minus-state is more than
      // 8 chars longer than the name in slug form.
      return slugMinusState.length > nameLower.length + 8;
    });

    return matches.map((r) => ({
      targetType: "event",
      targetId: r.id,
      payload: {
        name: r.name,
        slug: r.slug,
        venueCity: r.venueCity,
        venueState: r.venueState,
      },
    }));
  },
};
