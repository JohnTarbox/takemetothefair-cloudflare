/**
 * OPE-378 defect 1 / OPE-458 scope 4 — one submission became several events.
 *
 * The multi-source pipeline emits one candidate per source (body prose, each
 * body URL, each OCR'd attachment) and never asks whether two of them describe
 * the same thing. Two live specimens:
 *
 *   Waterville Elks (2026-08-11)
 *     body prose        -> "28th Annual Craft Fair"
 *     body prose (again)-> "28th Annual Holiday Craft Fair"   [+ the flyer image]
 *     facebook.com URL  -> a third "event" that was really a failed fetch
 *     ...from an email describing exactly one craft fair.
 *
 *   Vineyard Artisans (2026-08-17)
 *     "Vineyard Artisans Festivals"  and  "Vineyard Artisans Festivals"
 *     — identical names, same submitter, six seconds apart, and the second was
 *     created with a `-2` slug suffix.
 *
 * ── Why the existing dedup could not catch either ────────────────────────
 *
 * `findDuplicate` returns `{ isDuplicate: false }` as soon as the candidate has
 * no parseable start date:
 *
 *     if (!haveDate) return { isDuplicate: false };
 *
 * Every name/venue stage needs the date window, so a DATELESS candidate is
 * undedupable by construction. `fc2b22bb` had `start_date = NULL`; its twin had
 * a date. Same name, same submitter, same minute — invisible to each other.
 *
 * That guard is right for the global check (a name match across the whole
 * catalog with no date to anchor it is far too loose) and wrong WITHIN one
 * submission, where the shared origin does the anchoring instead. Two
 * candidates from the same email with the same normalized name are the same
 * event whether or not we managed to parse a date for one of them.
 *
 * ── Merge, don't just drop ───────────────────────────────────────────────
 *
 * Picking a survivor arbitrarily is how OPE-378 defect 5 happened: the flyer
 * image attached to only one of the two duplicates, so a reviewer keeping the
 * wrong one silently lost it. The richest candidate wins, so clustering fixes
 * that defect as a side effect rather than needing its own rule.
 */

import { normalizeName } from "./normalize-name-shim.js";

/** The slice of a pipeline candidate this needs. Structural, so the real
 *  SourceCandidate is assignable without importing the workflow. */
export interface ClusterableCandidate {
  name?: string | null;
  startDate?: string | null;
  venueName?: string | null;
  endDate?: string | null;
  description?: string | null;
  imageKey?: string | null;
  url?: string | null;
}

/** How much a candidate actually carries — higher wins a merge. */
export function richness(c: ClusterableCandidate): number {
  let n = 0;
  if (c.startDate) n += 3; // dates are what a listing is for
  if (c.endDate) n += 1;
  if (c.venueName) n += 2;
  if (c.imageKey) n += 2; // OPE-378 #5: never lose the flyer
  if (c.description && c.description.trim().length > 40) n += 1;
  if (c.url) n += 1; // provenance
  return n;
}

/**
 * Do two names from ONE submission denote the same event?
 *
 * Exact normalized equality is the Vineyard case. The Waterville case needs
 * more: "28th Annual Craft Fair" and "28th Annual Holiday Craft Fair" normalize
 * to `craft fair` and `holiday craft fair`, which are not equal — the extractor
 * invented "Holiday" on one pass and not the other, and no string comparison
 * that respects both names can call them identical.
 *
 * So the second rule is CONTAINMENT: one name's tokens are a subset of the
 * other's. `{craft, fair} ⊂ {holiday, craft, fair}`.
 *
 * This is a rule that would be far too loose in the global catalog — plenty of
 * unrelated fairs contain each other's words — and is safe here only because
 * the candidates share an origin: they came out of ONE email, about which the
 * sender was writing about one thing. That is the same asymmetry the whole
 * module rests on.
 *
 * Floor of two tokens, so a bare "Fair" does not swallow every fair in the
 * message. Callers still get the edition guard on top.
 */
function tokensOf(name: string): Set<string> {
  return new Set(normalizeName(name).split(" ").filter(Boolean));
}

function isSubset(small: Set<string>, big: Set<string>): boolean {
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

export function namesDenoteSameEvent(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 2) return false;
  return isSubset(small, big);
}

/** Same edition? Both dated and more than a week apart means different ones. */
function sameEdition(a: ClusterableCandidate, b: ClusterableCandidate): boolean {
  if (!a.startDate || !b.startDate) return true; // one is undated — assume same
  const ta = new Date(a.startDate).getTime();
  const tb = new Date(b.startDate).getTime();
  if (isNaN(ta) || isNaN(tb)) return true;
  return Math.abs(ta - tb) <= 7 * 24 * 60 * 60 * 1000;
}

export interface ClusterResult<T extends ClusterableCandidate> {
  /** One survivor per distinct event. */
  kept: T[];
  /** Candidates folded into a survivor — reported, never silently dropped.
   *  `intoIndex` indexes `kept`, so a caller can salvage anything the loser
   *  carried and the winner does not (the flyer, chiefly). Stable: survivors
   *  are replaced in place, never spliced. */
  collapsed: Array<{ candidate: T; intoIndex: number; intoName: string }>;
}

/**
 * Collapse candidates from ONE submission that describe the same event.
 *
 * Matched on the normalized name (which already strips leading ordinals
 * "28th "/"Annual ", a trailing year, and punctuation) plus token containment —
 * so "28th Annual Craft Fair", "Craft Fair 2026" and "28th Annual Holiday Craft
 * Fair" all cluster, while "Craft Fair" and "Antiques Fair" do not. See
 * `namesDenoteSameEvent` for why containment is safe here and nowhere else.
 *
 * Note the survivor may carry the LESS grounded name — Waterville keeps the
 * "Holiday" variant because it carries the flyer. That is deliberate: losing an
 * image is unrecoverable, whereas an invented word is caught separately by the
 * OPE-378 name-grounding gate, which flags the event for review.
 *
 * Candidates with no usable name pass through untouched: there is nothing to
 * cluster on, and guessing would be worse than a duplicate.
 *
 * A DIFFERENT edition (both dated, more than a week apart) is deliberately kept
 * separate — that is OPE-454's multi-show series case, where collapsing would
 * destroy exactly the editions we fought to preserve.
 */
export function clusterSubmissionCandidates<T extends ClusterableCandidate>(
  candidates: ReadonlyArray<T>
): ClusterResult<T> {
  const kept: T[] = [];
  const collapsed: Array<{ candidate: T; intoIndex: number; intoName: string }> = [];

  for (const c of candidates) {
    const key = c.name ? normalizeName(c.name) : "";
    if (!key) {
      kept.push(c);
      continue;
    }
    const matchIdx = kept.findIndex(
      (k) => k.name && namesDenoteSameEvent(k.name, c.name as string) && sameEdition(k, c)
    );
    if (matchIdx === -1) {
      kept.push(c);
      continue;
    }
    // Same event, twice. Keep whichever carries more.
    const incumbent = kept[matchIdx];
    if (richness(c) > richness(incumbent)) {
      kept[matchIdx] = c;
      collapsed.push({ candidate: incumbent, intoIndex: matchIdx, intoName: c.name ?? key });
    } else {
      collapsed.push({ candidate: c, intoIndex: matchIdx, intoName: incumbent.name ?? key });
    }
  }

  return { kept, collapsed };
}
