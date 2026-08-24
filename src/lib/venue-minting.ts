/**
 * Minting a venue from ingest prose.
 *
 * ── Authorization ────────────────────────────────────────────────────────
 * John ruled on 2026-08-24: "yes, ingest should mint venues from email
 * prose." That answers OPE-531's open question and unblocks OPE-541.
 *
 * ── What this is fixing ──────────────────────────────────────────────────
 * `autoLinkVenue` matches only — `venue-matching.ts` never inserts into the
 * venues table at all. So a venue we have never seen cannot resolve, and event
 * `25c9c493` was stored with `venue_id = NULL` while its own description read
 * "Doody's Totoket Inn Restaurant … 465 Foxon Rd, North Branford, CT 06471".
 * 51 events currently carry a null venue with a description; 16 of those
 * contain a street-ish address.
 *
 * ── Why this file is mostly guards ───────────────────────────────────────
 * OPE-541 deliverable 4 asks, explicitly, what stops this minting
 * near-duplicate venue rows. That is not a hypothetical: the `createSlug`
 * divergence of #120 minted silent duplicate venues in production, and
 * OPE-473 spent an entire ticket consolidating duplicate parents afterwards.
 * A wrong venue is worse than no venue — it puts an event on the wrong city
 * page AND hands `findDuplicate`'s venue_date stage a false anchor, so the
 * error propagates into dedup rather than sitting still.
 *
 * The guards, and the evidence for each:
 *
 *   1. ONLY on `no-match`. Never on `ambiguous` — that decision means we
 *      already found several candidates and could not choose; minting there
 *      adds a third row to a set we were unsure about. Never on `no-name` —
 *      there is nothing to mint from.
 *
 *   2. Name AND city AND state required. Measured against prod: of 992 venue
 *      rows, `city` and `state` are empty on ZERO. Empty `address` (169) and
 *      empty `zip` (183) are established practice, so those stay optional.
 *      This is the table's real invariant, not an invented bar — and it is
 *      what stops "Doody's Restaurant" with no location becoming a row that
 *      can never be matched against or corrected.
 *
 *   3. A name that is not a venue name is refused. Today's challenge-page
 *      incident produced an event literally named "Just a moment..."
 *      (OPE-537); the challenge detector now stops that upstream, but a
 *      minting path should not depend on a guard in another subsystem
 *      holding.
 *
 *   4. A re-check by normalized name + state immediately before insert. Two
 *      submissions naming the same new venue arrive minutes apart in this
 *      pipeline; without this, both mint.
 *
 *   5. Slug through `createSlug`, never a hand-rolled chain (#120's three-
 *      layer defense), with numeric suffixing on collision — and the insert
 *      itself wrapped, because the check and the write are not atomic.
 *
 *   6. `recordMutation` with a distinct actor, so the minted cohort is
 *      identifiable and reversible later (the OPE-433 convention).
 */
import { eq, and, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { venues } from "@/lib/db/schema";
import { createSlug, appendSlugSegment } from "@/lib/utils";
import { recordMutation } from "@/lib/audit/record-mutation";
import type { Slug } from "@takemetothefair/utils";

type Db = DrizzleD1Database<typeof schema>;

/** Minimum trimmed length for something to be plausibly a venue name. */
export const MIN_VENUE_NAME_CHARS = 3;

/** How many slug candidates to try before giving up rather than colliding. */
export const SLUG_ATTEMPTS = 50;

/**
 * Names that are never a venue. Kept SHORT and exact-match-after-normalizing:
 * a substring denylist would refuse "Online Academy Hall" and "The Various
 * Arts Center", which are plausible real places. The cost asymmetry here is
 * the opposite of the challenge detector's — a false refusal costs one null
 * venue that an operator can fill in, but a false ACCEPT creates a permanent
 * junk row that other events will then match against.
 */
const NON_VENUE_NAMES = new Set([
  "tbd",
  "tba",
  "n/a",
  "na",
  "none",
  "unknown",
  "online",
  "virtual",
  "various",
  "various locations",
  "multiple locations",
  "to be determined",
  "to be announced",
  "just a moment...",
]);

export type MintRefusalReason =
  | "decision-not-no-match"
  | "missing-name"
  | "missing-city-or-state"
  | "name-too-short"
  | "name-not-a-venue"
  | "unsluggable-name"
  | "slug-exhausted"
  | "insert-failed";

export type MintVenueResult =
  | { minted: true; venueId: string; slug: Slug; reason: null }
  | { minted: false; venueId: string; slug: null; reason: "matched-on-recheck" }
  | { minted: false; venueId: null; slug: null; reason: MintRefusalReason };

export interface MintVenueInput {
  /** The `decision` autoLinkVenue returned. Minting is only legal on no-match. */
  decision: string;
  venueName?: string | null;
  venueAddress?: string | null;
  venueCity?: string | null;
  venueState?: string | null;
}

/**
 * The two halves of the re-check's comparison. They MUST agree.
 *
 * The first version of this normalized only the input — `LOWER(TRIM(name))` on
 * the column against a quote-stripped string in JS — which meant the guard
 * could never match a name containing an apostrophe. That is the specimen's
 * own name ("Doody's Totoket Inn Restaurant"): the duplicate-suppressing
 * guard was inert for precisely the row the ticket is about, and silently, in
 * the direction that mints. Hence `normalization agrees on both sides` in the
 * tests — a table of inputs asserted equal through SQL and through JS.
 *
 * Curly quotes are folded too. Extractors take prose from web pages, where
 * U+2019 is what a typographic apostrophe actually is; treating it as a
 * different character from `'` would reopen the same hole one codepoint over.
 */
const STRIPPED_QUOTES = ['"', "'", "`", "\u2019", "\u2018"];

/** JS half. */
function normalizeName(s: string): string {
  let out = s.toLowerCase();
  for (const q of STRIPPED_QUOTES) out = out.split(q).join("");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * SQL half — the same steps in the same order, over a column.
 *
 * Whitespace: SQLite has no regex, so runs are collapsed by three passes of
 * `REPLACE('  ', ' ')`, which flattens up to 8 consecutive spaces. Tabs and
 * newlines are mapped to spaces first. A name with more than 8 consecutive
 * spaces falls back to not matching — it mints a row instead of linking, which
 * is the same outcome as having no guard and never the wrong link.
 */
function normalizedNameSql(col: SQLiteColumn) {
  let expr = sql`LOWER(${col})`;
  for (const q of STRIPPED_QUOTES) {
    expr = sql`REPLACE(${expr}, ${q}, '')`;
  }
  expr = sql`REPLACE(REPLACE(${expr}, char(9), ' '), char(10), ' ')`;
  for (let i = 0; i < 3; i++) expr = sql`REPLACE(${expr}, '  ', ' ')`;
  return sql`TRIM(${expr})`;
}

/**
 * Create a venue from extracted prose, or explain why not.
 *
 * Returns `matched-on-recheck` (with a venueId) when the pre-insert re-check
 * finds a row the matcher missed — that is a successful LINK, not a refusal,
 * and the caller should use the id.
 */
export async function mintVenueFromIngest(db: Db, input: MintVenueInput): Promise<MintVenueResult> {
  // Guard 1 — only on no-match.
  if (input.decision !== "no-match") {
    return { minted: false, venueId: null, slug: null, reason: "decision-not-no-match" };
  }

  const name = input.venueName?.trim() ?? "";
  if (!name) return { minted: false, venueId: null, slug: null, reason: "missing-name" };

  // Guard 3 — plausible venue name.
  if (name.length < MIN_VENUE_NAME_CHARS) {
    return { minted: false, venueId: null, slug: null, reason: "name-too-short" };
  }
  if (NON_VENUE_NAMES.has(normalizeName(name))) {
    return { minted: false, venueId: null, slug: null, reason: "name-not-a-venue" };
  }

  // Guard 2 — city and state are the table's real invariant (0/992 empty).
  const city = input.venueCity?.trim() ?? "";
  const state = input.venueState?.trim().toUpperCase() ?? "";
  if (!city || !state) {
    return { minted: false, venueId: null, slug: null, reason: "missing-city-or-state" };
  }

  // Guard 4 — re-check on normalized name + state. The matcher pulls its
  // candidate set by LIKE on the first token and caps at 100 rows, so it can
  // miss an exact row in a crowded prefix; this also closes the window where
  // two submissions for the same new venue arrive together.
  const existing = await db
    .select({ id: venues.id })
    .from(venues)
    .where(
      and(
        sql`${normalizedNameSql(venues.name)} = ${normalizeName(name)}`,
        sql`UPPER(TRIM(${venues.state})) = ${state}`
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return { minted: false, venueId: existing[0].id, slug: null, reason: "matched-on-recheck" };
  }

  // Guard 5 — canonical slug via `createSlug`, never a hand-rolled chain.
  //
  // `createSlug` can legitimately return "" — a name of only punctuation or of
  // a script `slugify` cannot transliterate has no slug. The column is UNIQUE
  // and NOT NULL, so the first such venue would take the empty slug and every
  // one after it would collide with it forever. Refuse instead.
  const base = createSlug(name);
  if (!base) {
    return { minted: false, venueId: null, slug: null, reason: "unsluggable-name" };
  }

  // Check the candidate we are about to use, not the one before it. The
  // check-then-assign shape (assign a suffix, loop, exit) leaves the final
  // value unverified, which is precisely the one that reaches the insert.
  let slug: Slug | null = null;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const candidate: Slug = attempt === 0 ? base : appendSlugSegment(base, attempt + 1);
    const clash = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.slug, candidate))
      .limit(1);
    if (clash.length === 0) {
      slug = candidate;
      break;
    }
  }
  if (!slug) {
    return { minted: false, venueId: null, slug: null, reason: "slug-exhausted" };
  }

  const venueId = crypto.randomUUID();

  // Guard 6 — name the creator, so this cohort stays identifiable and
  // reversible. `recordMutation` swallows its own failures and returns a
  // boolean rather than throwing, so an audit row can never cost the venue;
  // that is the OPE-433 contract and it needs no wrapper here.
  await recordMutation(db, {
    entityType: "venue",
    entityId: venueId,
    verb: "create",
    actor: "email-ingest",
    after: { name, city, state, address: input.venueAddress?.trim() || "" },
    note: "OPE-541 — minted from ingest prose after autoLinkVenue returned no-match",
  });

  try {
    await db.insert(venues).values({
      id: venueId,
      name,
      slug,
      // Empty is established practice for these two (169 and 183 rows),
      // and inventing an address is exactly the failure OPE-537 was about.
      address: input.venueAddress?.trim() || "",
      city,
      state,
      zip: "",
      status: "ACTIVE",
    });
  } catch {
    // The re-check above and the slug scan are both read-then-write, so two
    // submissions naming the same new venue can pass them together and race
    // on the UNIQUE slug index. Losing that race must NOT fail the
    // submission: without minting at all this event would have saved with
    // venue_id NULL, so a 500 here would be a regression caused by an
    // improvement. Re-read — the winner's row is what we wanted anyway.
    const winner = await db
      .select({ id: venues.id })
      .from(venues)
      .where(
        and(
          sql`${normalizedNameSql(venues.name)} = ${normalizeName(name)}`,
          sql`UPPER(TRIM(${venues.state})) = ${state}`
        )
      )
      .limit(1);
    if (winner.length > 0) {
      return { minted: false, venueId: winner[0].id, slug: null, reason: "matched-on-recheck" };
    }
    return { minted: false, venueId: null, slug: null, reason: "insert-failed" };
  }

  return { minted: true, venueId, slug, reason: null };
}
