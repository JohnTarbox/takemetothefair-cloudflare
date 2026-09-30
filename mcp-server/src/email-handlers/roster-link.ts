/**
 * OPE-847 — link a crawled exhibitor roster to its event.
 *
 * ## Authorization
 *
 * This is the customer-facing half of OPE-837 scope 3, approved by John in
 * session on 2026-09-07 (*"yes, do option (a)"*) after OPE-840 put the choice
 * to him. It creates **public vendor profiles** from an unreviewed submission,
 * which is why it needed an explicit operator decision and why the guards
 * below are not optional.
 *
 * ⚠️ **Forward-only.** OPE-837's other STOP-gate stands: nothing here may be
 * run as a backfill over existing events without its own approval.
 *
 * ## Why the defaults are not a judgement call
 *
 * Measured in prod on the specimen event `9d45da16`, which an operator
 * resolved by hand: all 63 `event_vendors` rows are
 * `CONFIRMED / EXHIBITOR / public_visible=1 / NOT_REQUIRED` — exactly
 * `createOrLinkVendor`'s default set. This matches the human's choice rather
 * than inventing one.
 *
 * ## The guards, and what each is for
 *
 *  - **`strict` dedup, never `fuzzy`.** OPE-837 records `fuzzy` as a known
 *    duplicate-minter, and a roster is the highest-volume write in this
 *    pipeline — the one place a bad dedup strategy compounds fastest.
 *  - **A cap per submission**, so a pathological page cannot mint hundreds of
 *    profiles from one email.
 *  - **A name gate at the WRITE boundary**, not only in the parser. The parser
 *    decides what a page said; this decides what deserves a public row, and
 *    those are different questions. Defence in depth is warranted precisely
 *    because the output is public.
 *  - **Per-name isolation.** One unparseable name must never cost the other 62,
 *    and must never fail the submission — the event already exists.
 */
import type { Db } from "../db.js";
import {
  createOrLinkVendor,
  type CreateOrLinkVendorResult,
  type VendorLinkDb,
} from "@takemetothefair/vendor-linking";

/** Hard ceiling on vendors linked from a single submission. */
export const ROSTER_LINK_MAX = 100;

/**
 * Names per workflow step.
 *
 * `createOrLinkVendor` runs several D1 statements per name (dedup search,
 * insert, link, completeness, audit). A 63-name roster in one step would sit
 * far outside a sane step timeout and, worse, would restart from zero on a
 * retry. Twelve keeps each step comfortably inside 30s and makes a partial
 * crawl resumable at batch granularity.
 */
export const ROSTER_LINK_BATCH = 12;

export interface RosterLinkOutcome {
  /** New vendor rows created. */
  created: number;
  /** Existing vendors newly linked to this event. */
  linked: number;
  /** Already linked before this run — the idempotent case. */
  alreadyLinked: number;
  /** Names rejected by the write-boundary gate. */
  rejected: number;
  /** Names that threw or returned `ok: false`. */
  failed: number;
  /** Bounded sample for the workflow record; never the whole roster. */
  failures: Array<{ name: string; error: string }>;
}

export function emptyRosterLinkOutcome(): RosterLinkOutcome {
  return { created: 0, linked: 0, alreadyLinked: 0, rejected: 0, failed: 0, failures: [] };
}

export function mergeRosterLinkOutcomes(
  a: RosterLinkOutcome,
  b: RosterLinkOutcome
): RosterLinkOutcome {
  return {
    created: a.created + b.created,
    linked: a.linked + b.linked,
    alreadyLinked: a.alreadyLinked + b.alreadyLinked,
    rejected: a.rejected + b.rejected,
    failed: a.failed + b.failed,
    failures: [...a.failures, ...b.failures].slice(0, 10),
  };
}

/**
 * Shapes that must never become a public vendor profile.
 *
 * Deliberately separate from the parser's `isPlausible`: that one asks "is
 * this a name the page listed", this one asks "does this deserve a row in a
 * public directory". A roster page can legitimately list "TBD" or "and many
 * more" and the parser is right to surface it; minting it is still wrong.
 */
const NOT_LINKABLE =
  /^(?:tbd|tba|and\s+more|many\s+more|more\s+to\s+come|coming\s+soon|to\s+be\s+announced|various|others?|etc\.?|n\/?a|none|unknown|vendors?|exhibitors?|artisans?|makers?|food\s+trucks?|sponsors?)$/i;

/** True when a roster name may be written as a vendor. */
export function isLinkableVendorName(raw: string): boolean {
  const name = raw.trim();
  if (name.length < 2 || name.length > 120) return false;
  // Must contain a letter — "2026", "#3" or "&" is not a business.
  if (!/[a-z]/i.test(name)) return false;
  if (NOT_LINKABLE.test(name)) return false;
  // A URL or an email address in the roster slot means the parser caught the
  // wrong span; do not mint a vendor called "https://example.org".
  if (/^https?:\/\//i.test(name) || /\S+@\S+\.\S+/.test(name)) return false;
  // A run of many words is a sentence, not a business name.
  if (name.split(/\s+/).length > 10) return false;
  return true;
}

/** Injected so tests exercise the batching, isolation and counting without D1. */
export type CreateOrLinkFn = (
  db: VendorLinkDb,
  input: Parameters<typeof createOrLinkVendor>[1],
  deps: Parameters<typeof createOrLinkVendor>[2]
) => Promise<CreateOrLinkVendorResult>;

export interface RosterLinkDeps {
  actorUserId: string | null;
  recomputeVendorCompleteness: Parameters<
    typeof createOrLinkVendor
  >[2]["recomputeVendorCompleteness"];
  logEnrichment: Parameters<typeof createOrLinkVendor>[2]["logEnrichment"];
  /** Defaults to the real `createOrLinkVendor`. */
  createOrLink?: CreateOrLinkFn;
}

/**
 * Link one batch of roster names to an event.
 *
 * Never throws: the event already exists, and roster enrichment must not be
 * able to undo a successful submission. Every failure is counted and sampled
 * instead.
 */
export async function linkRosterBatch(
  db: Db,
  args: {
    eventId: string;
    names: readonly string[];
    /** The page that listed these names — recorded on the audit note. */
    sourceUrl: string;
  },
  deps: RosterLinkDeps
): Promise<RosterLinkOutcome> {
  const out = emptyRosterLinkOutcome();
  const create = deps.createOrLink ?? createOrLinkVendor;

  for (const rawName of args.names) {
    const name = rawName.trim();
    if (!isLinkableVendorName(name)) {
      out.rejected++;
      continue;
    }
    try {
      const res = await create(
        db as unknown as VendorLinkDb,
        {
          eventId: args.eventId,
          businessName: name,
          // NEVER fuzzy. See the docblock.
          dedupStrategy: "strict",
          // The operator's own resolution of this exact roster, matched
          // field-for-field rather than chosen.
          status: "CONFIRMED",
          participationType: "EXHIBITOR",
          paymentStatus: "NOT_REQUIRED",
          publicVisible: true,
        },
        {
          actorUserId: deps.actorUserId,
          recomputeVendorCompleteness: deps.recomputeVendorCompleteness,
          logEnrichment: deps.logEnrichment,
        }
      );

      if (!res.ok) {
        out.failed++;
        if (out.failures.length < 10) out.failures.push({ name, error: res.error });
        continue;
      }
      if (res.wasAlreadyLinked) out.alreadyLinked++;
      else if (res.wasCreated) out.created++;
      else out.linked++;
    } catch (err) {
      // Isolated per name, by design.
      out.failed++;
      if (out.failures.length < 10) {
        out.failures.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return out;
}

/**
 * Split a roster into the batches the workflow will run as separate steps,
 * applying the per-submission cap first.
 *
 * Returns `[]` for an empty roster, so the caller performs no steps at all
 * rather than one step that does nothing.
 */
export function planRosterBatches(names: readonly string[]): string[][] {
  const capped = names.slice(0, ROSTER_LINK_MAX);
  const batches: string[][] = [];
  for (let i = 0; i < capped.length; i += ROSTER_LINK_BATCH) {
    batches.push(capped.slice(i, i + ROSTER_LINK_BATCH));
  }
  return batches;
}
