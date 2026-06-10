/**
 * Event-page vendor display resolution (EH2 brand_parent collapse).
 *
 * On an event's participating-vendor list, a LOCAL_OFFICE that canonical-ups
 * to its brand (brand_parent mode) or operator (operator_parent mode) must be
 * shown as the PARENT — brand name + link to the brand hub — never as the
 * regional office. This keeps brand_parent brands (e.g. LeafFilter) presenting
 * a single public face everywhere offices appear. self/both-mode offices and
 * INDEPENDENT vendors are unaffected (shown as themselves).
 *
 * Composes the two canonical resolvers so event pages stay in lockstep with
 * the office page's rel=canonical and the middleware 301:
 *   - displayVendorName     → the name to render
 *   - canonicalParentSlugFor → the slug to link to (hub when collapsing)
 */
import {
  canonicalParentSlugFor,
  displayVendorName,
  type DisplayableParent,
  type DisplayableVendor,
} from "@takemetothefair/utils";

/** Minimal vendor shape needed to resolve an event-vendor's public display. */
export interface EventVendorDisplayRow extends DisplayableVendor {
  slug: string;
  businessName: string;
  displayName: string | null;
}

/** Minimal parent shape (brand or operator parent). */
export interface EventVendorParentRow extends DisplayableParent {
  slug: string;
  businessName: string;
  displayName: string | null;
}

export interface ResolvedEventVendor {
  /** Public name: brand/operator name when collapsing, else the office/self name. */
  name: string;
  /** Public slug to link to: hub slug when collapsing, else the vendor's own slug. */
  slug: string;
}

/**
 * Resolve the public-facing {name, slug} for an event's participating vendor,
 * applying the brand_parent / operator_parent collapse. Falls back to the
 * vendor's own self-name + slug for self/both modes and INDEPENDENT rows
 * (and defensively when the relevant parent row wasn't loaded).
 */
export function resolveEventVendorTarget(
  vendor: EventVendorDisplayRow,
  brandParent: EventVendorParentRow | null,
  operatorParent: EventVendorParentRow | null
): ResolvedEventVendor {
  const name = displayVendorName(vendor, brandParent, operatorParent);
  const targetSlug = canonicalParentSlugFor(
    vendor,
    brandParent
      ? {
          id: brandParent.id,
          role: brandParent.role,
          defaultChildDisplay: brandParent.defaultChildDisplay,
        }
      : null,
    brandParent?.slug ?? null,
    operatorParent?.slug ?? null
  );
  return { name, slug: targetSlug ?? vendor.slug };
}

/**
 * Dedupe already-resolved event vendors by their public slug, preserving
 * first-seen order. Collapses multiple offices of the same brand (which now
 * resolve to the same hub slug) into a single card. No-op for the common case
 * where every vendor resolves to a distinct slug.
 */
export function dedupeByResolvedSlug<T>(rows: T[], slugOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const slug = slugOf(row);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(row);
  }
  return out;
}
