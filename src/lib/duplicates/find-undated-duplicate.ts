/**
 * OPE-1156 — the duplicate check a submission with NO DATE never got.
 *
 * `findDuplicate` returns right after its URL stage when there is no
 * `startDate` (find-duplicate.ts, the "No startDate → no place/name matching is
 * meaningful" early return), and `detectPossibleDuplicate` needs a day to
 * collide on. So a dateless submission was compared on source URL alone. On
 * 2026-09-24 that let "50th Common Ground Country Fair" in at the SAME venue as
 * the live, APPROVED "Common Ground Country Fair 2026", with its own series and
 * a public slug.
 *
 * ## Why this is only for rows WITHOUT a date
 *
 * For a dated row, the same venue and the same name usually means a different
 * EDITION — next year's fair, next week's market — and the dated stages already
 * handle that with a date window. With no date there is no edition to tell
 * apart, so a same-place, same-name match is the best evidence available. Using
 * this on dated rows would flag every recurring event against its own history.
 *
 * ## Advisory, never a verdict
 *
 * The result feeds `events.possible_duplicate_of`, which a human triages in the
 * duplicate-flag queue. Nothing here rejects, merges or hides anything.
 *
 * Two rules, both on the normalised name (`normalizeName`: case-folded, leading
 * ordinals and "Annual" and a trailing year stripped):
 *   1. same `venue_id` — exact match, or the shorter name wholly contained in
 *      the longer with at least two distinctive shared tokens;
 *   2. no venue — same city and state (via the candidate's venue), and the same
 *      exact-or-containment match. Scoped to the city on purpose: "Art in the
 *      Park" in Waterville is not the "Art in the Park" at Maine Wildlife Park.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { events, venues } from "@/lib/db/schema";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { nameContainmentMatch } from "@/lib/duplicates/name-containment";

export interface UndatedCandidateInput {
  name: string | null | undefined;
  venueId?: string | null;
  city?: string | null;
  stateCode?: string | null;
  /** The row being checked, when it already exists (backfill). Never matches itself. */
  selfId?: string | null;
}

export type UndatedMatch = {
  eventId: string;
  rule: "same_venue" | "same_city";
  how: "exact" | "containment";
};

/** Statuses a duplicate could be OF. A rejected or merged row is not a live twin. */
const LIVE_OR_PENDING = ["APPROVED", "TENTATIVE", "PENDING"] as const;

/** APPROVED first: flag against the row a human would keep. */
const STATUS_RANK: Record<string, number> = { APPROVED: 0, TENTATIVE: 1, PENDING: 2 };

function tokenCount(name: string): number {
  return normalizeName(name).split(/\s+/).filter(Boolean).length;
}

/** Pure name test, exported for tests: exact normalised match wins over containment. */
export function undatedNameMatch(a: string, b: string): "exact" | "containment" | null {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return null;
  if (na === nb) return "exact";
  return nameContainmentMatch(na, nb) ? "containment" : null;
}

export async function findUndatedDuplicate(
  db: Database,
  input: UndatedCandidateInput
): Promise<UndatedMatch | null> {
  if (!input.name || !normalizeName(input.name)) return null;

  type Row = {
    id: string;
    name: string;
    status: string;
    startDate: Date | null;
  };
  let rows: Row[] = [];
  let rule: UndatedMatch["rule"];

  if (input.venueId) {
    rule = "same_venue";
    rows = await db
      .select({
        id: events.id,
        name: events.name,
        status: events.status,
        startDate: events.startDate,
      })
      .from(events)
      .where(
        and(
          eq(events.venueId, input.venueId),
          isNull(events.mergedInto),
          inArray(events.status, [...LIVE_OR_PENDING])
        )
      );
  } else if (input.city && input.stateCode) {
    rule = "same_city";
    rows = await db
      .select({
        id: events.id,
        name: events.name,
        status: events.status,
        startDate: events.startDate,
      })
      .from(events)
      .innerJoin(venues, eq(events.venueId, venues.id))
      .where(
        and(
          sql`lower(${venues.city}) = ${input.city.trim().toLowerCase()}`,
          eq(venues.state, input.stateCode.trim().toUpperCase()),
          isNull(events.mergedInto),
          inArray(events.status, [...LIVE_OR_PENDING])
        )
      );
  } else {
    return null;
  }

  const wanted = tokenCount(input.name);
  const matches = rows
    .filter((r) => r.id !== input.selfId)
    .map((r) => ({ r, how: undatedNameMatch(input.name as string, r.name) }))
    .filter((m): m is { r: Row; how: "exact" | "containment" } => m.how !== null)
    // Order: exact before containment; then the CLOSEST name (fewest extra
    // words — "Waterville Farmers' Market" is its Thursday market, not the
    // "… Winter 2026–2027" one, measured on prod 2026-09-25); then APPROVED
    // before TENTATIVE before PENDING; then the latest edition.
    .sort(
      (x, y) =>
        (x.how === "exact" ? 0 : 1) - (y.how === "exact" ? 0 : 1) ||
        Math.abs(tokenCount(x.r.name) - wanted) - Math.abs(tokenCount(y.r.name) - wanted) ||
        (STATUS_RANK[x.r.status] ?? 9) - (STATUS_RANK[y.r.status] ?? 9) ||
        (y.r.startDate?.getTime() ?? 0) - (x.r.startDate?.getTime() ?? 0)
    );

  const best = matches[0];
  return best ? { eventId: best.r.id, rule, how: best.how } : null;
}
