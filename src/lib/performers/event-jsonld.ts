/**
 * OPE-114 — build the schema.org `performer` who-list for an Event node from its
 * CONFIRMED appearances (spec §6.1). Pure + no I/O.
 *
 * Rules:
 *  - @type: PERSON → Person · GROUP → PerformingGroup · GROUP+act_category=MUSIC
 *    → MusicGroup · unknown → Person (safe default for a "who" entry).
 *  - DEDUPE by performer: the parent Event's `performer` is a who-list, so a
 *    performer with multiple confirmed sets appears ONCE (per-set times live on
 *    sub-Events, §6.1a — behind a flag, not here).
 *  - Ordered by billing (HEADLINER first), then name.
 *  - Returns `undefined` when there are no confirmed acts — the caller omits the
 *    property entirely (never an empty array).
 */

export type PerformerType = "PERSON" | "GROUP" | null;
export type Billing = "HEADLINER" | "FEATURED" | "SUPPORTING" | null;

export interface ConfirmedAppearance {
  name: string;
  slug: string;
  performerType: PerformerType;
  actCategory: string | null;
  /** Official site / FB — becomes schema.org `sameAs`. */
  sameAs?: string | null;
  imageUrl?: string | null;
  billing: Billing;
  /** epoch-seconds — only used by the sub-Event path (§6.1a). */
  performanceStart?: number | null;
  performanceEnd?: number | null;
  stage?: string | null;
}

export interface PerformerNode {
  "@type": "Person" | "PerformingGroup" | "MusicGroup";
  name: string;
  url: string;
  sameAs?: string;
  image?: string;
}

const BILLING_RANK: Record<string, number> = { HEADLINER: 0, FEATURED: 1, SUPPORTING: 2 };

export function performerSchemaType(
  type: PerformerType,
  actCategory: string | null
): PerformerNode["@type"] {
  if (type === "GROUP") return actCategory === "MUSIC" ? "MusicGroup" : "PerformingGroup";
  return "Person"; // PERSON or unknown
}

/**
 * Deduped, billing-ordered `performer` who-list, or `undefined` if none.
 * `siteUrl` is the canonical origin (no trailing slash).
 */
export function buildPerformerNodes(
  appearances: ConfirmedAppearance[],
  siteUrl: string
): PerformerNode[] | undefined {
  if (!appearances || appearances.length === 0) return undefined;

  // Dedupe by slug; keep the STRONGEST billing seen for ordering (a headliner
  // set outranks a supporting set for the same act).
  const bySlug = new Map<string, ConfirmedAppearance>();
  for (const a of appearances) {
    if (!a.slug || !a.name) continue;
    const prev = bySlug.get(a.slug);
    if (!prev) {
      bySlug.set(a.slug, a);
    } else {
      const prevRank = BILLING_RANK[prev.billing ?? ""] ?? 3;
      const curRank = BILLING_RANK[a.billing ?? ""] ?? 3;
      if (curRank < prevRank) bySlug.set(a.slug, a);
    }
  }
  if (bySlug.size === 0) return undefined;

  const nodes = [...bySlug.values()]
    .sort(
      (x, y) =>
        (BILLING_RANK[x.billing ?? ""] ?? 3) - (BILLING_RANK[y.billing ?? ""] ?? 3) ||
        x.name.localeCompare(y.name)
    )
    .map((a) => {
      const node: PerformerNode = {
        "@type": performerSchemaType(a.performerType, a.actCategory),
        name: a.name,
        url: `${siteUrl}/performers/${a.slug}`,
      };
      if (a.sameAs) node.sameAs = a.sameAs;
      if (a.imageUrl) node.image = a.imageUrl;
      return node;
    });
  return nodes.length > 0 ? nodes : undefined;
}
