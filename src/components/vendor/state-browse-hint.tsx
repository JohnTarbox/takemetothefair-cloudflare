"use client";

// OPE-831 — the vendor profile form's location fields, and what leaving them
// blank actually costs.
//
// 13 of 94 real claimed vendors saved this form and still left `state` blank
// (measured in prod 2026-09-07). Nothing told them the consequence:
// `groupByState` (src/lib/browse/directory.ts) skips any entry whose state
// fails `isBrowseStateCode`, so the listing is absent from every
// /vendors/browse/state/[state] page — with no fallback bucket and no
// counterpart page to land on.
//
// ⚠️ This is a COMPONENT rather than inline JSX for a testing reason, not a
// styling one. The invariant worth protecting is "this warns exactly when the
// grouper would drop you", and a test that only exercised `isBrowseStateCode`
// would stay green if someone rewrote the render condition to a bare blank
// check. The test renders THIS, so the condition under test is the one that
// ships.
import { isBrowseStateCode } from "@/lib/browse/state-codes";

export interface StateBrowseHintProps {
  /** The State field's current value. */
  state: string;
  /** Reveal the (default-collapsed) Google business lookup, which fills
   *  address/city/state/lat/lng in one click. */
  onUseLookup: () => void;
}

/**
 * Renders nothing when the state would reach a browse page — silence is the
 * correct output for a listing that is fine.
 *
 * Deliberately informational, never blocking. Whether a vendor MUST have a
 * location is an open product question on OPE-831: a mail-order-only vendor
 * legitimately has none, and making the field `required` would buy a false
 * address rather than a real one.
 */
export function StateBrowseHint({ state, onUseLookup }: StateBrowseHintProps) {
  // The SAME predicate the grouper uses. Fires on a non-blank but unrecognised
  // code ("XX", "Maine") too — equally invisible in browse, and the case a
  // blank-only check would miss while looking correct.
  if (isBrowseStateCode(state)) return null;

  const typed = (state ?? "").trim();
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="state-browse-hint">
      {typed
        ? `“${typed}” isn’t a US state code, so your listing won’t appear on the by-state browse pages.`
        : "Without a state, your listing won’t appear on the by-state browse pages that shoppers use to find local vendors."}{" "}
      <button
        type="button"
        onClick={onUseLookup}
        className="underline text-royal hover:text-navy-dark"
      >
        Find my business on Google
      </button>{" "}
      fills this in for you.
    </p>
  );
}
