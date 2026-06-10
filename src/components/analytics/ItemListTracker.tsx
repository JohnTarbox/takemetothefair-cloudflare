"use client";

import { useEffect } from "react";
import { trackViewItemList, trackSelectItem, type ItemListEntry } from "@/lib/analytics";

interface ItemListTrackerProps {
  /** GA4 item_list_name, e.g. "events_listing" / "vendors_browse". */
  listName: string;
  /** First-page items in render order (id/slug/name). */
  items: ItemListEntry[];
  /** URL prefix the cards link to, e.g. "/events". Used to scope which
   *  click counts as a select_item for this list. */
  hrefPrefix: string;
}

/**
 * ENG1.6 (Dev-Email-2026-06-10 §B, 2026-06-10) — browse CTR instrumentation.
 *
 * Drop one of these into a listing page (Server Component) alongside the
 * existing <ItemListSchema>. On mount it fires `view_item_list`; it then
 * delegates a single capture-phase click listener that fires `select_item`
 * when a reader clicks a card link whose slug matches one of `items`.
 *
 * Delegation (vs. an onClick per card) keeps this zero-touch on the card
 * components and naturally scopes clicks: we only emit for hrefs of the form
 * `<hrefPrefix>/<slug>` where <slug> is in this page's item set, so nav /
 * footer / pagination links never fire it.
 */
export function ItemListTracker({ listName, items, hrefPrefix }: ItemListTrackerProps) {
  useEffect(() => {
    trackViewItemList(listName, items);

    const bySlug = new Map(items.map((it, index) => [it.slug, { it, index }]));
    const prefix = hrefPrefix.endsWith("/") ? hrefPrefix : `${hrefPrefix}/`;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith(prefix)) return;
      // Slug = first path segment after the prefix, minus any query/hash.
      const slug = href.slice(prefix.length).split(/[/?#]/)[0];
      const match = bySlug.get(slug);
      if (match) trackSelectItem(listName, match.it, match.index);
    };

    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, [listName, items, hrefPrefix]);

  return null;
}
