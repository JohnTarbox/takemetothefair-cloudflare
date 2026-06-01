/**
 * Venues whose stored `name` looks like a raw street address.
 *
 * Cohort 8 (analyst, 2026-06-01) — C9/U9 from the dev-email bundle.
 * Pairs with displayVenueName() in src/lib/venue-display.ts which
 * suppresses bad names at READ time; this rule surfaces the rows so
 * the operator can rename them at the source.
 *
 * Detection: SQL regex equivalent (LIKE patterns approximated since
 * SQLite has no native regex without an extension). We anchor on
 * "name starts with one-or-more digits followed by whitespace" — the
 * same conservative check the display fallback uses. SQLite's
 * GLOB '[0-9]*' works but doesn't enforce "followed by space," so
 * we use a parameterized LIKE with explicit digit-leading patterns.
 *
 * Severity yellow because it's data quality, not broken. autoResolve
 * true so the rule clears as the operator renames each row.
 */

import { and, or, sql } from "drizzle-orm";
import { venues } from "@/lib/db/schema";
import type { ItemMatch, RuleDefinition } from "../engine";

export const venuesNamedByAddressRule: RuleDefinition = {
  ruleKey: "venues_named_by_address",
  title: "Venues whose name looks like a street address",
  rationaleTemplate:
    '{n} venues have a stored name that starts with a street-number pattern (e.g. "18 Spring Street") instead of a real name. Public pages now fall back to "Event venue in <City>, <State>" so users don\'t see the bare address, but the source data should still be cleaned up via the venue edit form.',
  severity: "yellow",
  category: "data-quality",
  autoResolve: true,
  async run(db): Promise<ItemMatch[]> {
    // Two predicates OR'd together:
    //   1. name starts with a digit followed by a space (covers "18 Spring",
    //      "100 Main", "42 Elm").
    //   2. name equals address (the form-copy-paste case).
    // We rely on SQLite GLOB for the digit-leading check; the result is
    // post-filtered in TypeScript against the canonical regex so we don't
    // false-positive on "21st", "Building 5", etc.
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        address: venues.address,
        city: venues.city,
        state: venues.state,
      })
      .from(venues)
      .where(
        and(
          // SQLite GLOB approximation: name starts with a digit
          sql`${venues.name} GLOB '[0-9]*'`,
          or(
            // Either name starts with digits-then-space ...
            sql`${venues.name} GLOB '[0-9]* *'`,
            // ... or name equals address (form copy-paste)
            sql`${venues.name} = ${venues.address}`
          )
        )
      );

    // Post-filter to enforce the exact same regex used by the display
    // helper. Drops false positives like "10X Studios" that the GLOB
    // alone would catch but the regex (which requires \s+\S after
    // the digit run) correctly rejects.
    const STREET_NUMBER_RE = /^\s*\d+\s+\S/;
    return rows
      .filter(
        (r) => STREET_NUMBER_RE.test(r.name) || (r.address && r.name.trim() === r.address.trim())
      )
      .map((r) => ({
        targetType: "venue",
        targetId: r.id,
        payload: {
          name: r.name,
          slug: r.slug,
          address: r.address ?? null,
          city: r.city ?? null,
          state: r.state ?? null,
        },
      }));
  },
};
