/**
 * OPE-395 — the internal-link nav that turns the facet pages into a mesh.
 *
 * Facet pages are worth little in isolation: a page Google cannot reach by
 * following links is a page that depends entirely on the sitemap for discovery
 * and receives no internal link equity. This block is what makes the mesh a
 * mesh, and it extends the OPE-40 internal-linking program rather than
 * inventing a second convention.
 *
 * ── Why no event counts next to the links ──────────────────────────────────
 * Showing "August (32)" would need a second count, computed differently from
 * the one the facet page itself uses to decide indexability — and the moment
 * those two disagree the nav advertises a number the page contradicts. That is
 * the drift `feedback_classifier_window_must_match_display` is about. Counting
 * every facet properly on every state-page render would instead mean ~35 extra
 * queries for decoration. Dropping the numbers removes the second source of
 * truth entirely; the page states its own count in its own H1 area.
 *
 * Linking to a facet that is currently `noindex` is deliberate and harmless: a
 * reader still gets a real listing, and the page starts asking to be indexed on
 * its own the moment the calendar fills. Internal `nofollow` would be worse than
 * useless here — it wastes the link without conserving anything.
 */
import Link from "next/link";
import { facetSlugsByKind, TYPE_FACETS } from "@/lib/events/facets";
import { findRegion } from "@/lib/events/facet-regions";

const MONTH_LABELS: Record<string, string> = {
  january: "January",
  february: "February",
  march: "March",
  april: "April",
  may: "May",
  june: "June",
  july: "July",
  august: "August",
  september: "September",
  october: "October",
  november: "November",
  december: "December",
};

interface FacetNavProps {
  stateSlug: string;
  stateName: string;
  /** Omit the link back to the facet the reader is already on. */
  currentFacetSlug?: string;
}

function Group({
  heading,
  links,
  stateSlug,
  currentFacetSlug,
}: {
  heading: string;
  links: Array<{ slug: string; label: string }>;
  stateSlug: string;
  currentFacetSlug?: string;
}) {
  const visible = links.filter((l) => l.slug !== currentFacetSlug);
  if (visible.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-2">
        {visible.map((l) => (
          <li key={l.slug}>
            <Link
              href={`/events/${stateSlug}/${l.slug}`}
              className="text-sm text-royal hover:text-navy hover:underline"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FacetNav({ stateSlug, stateName, currentFacetSlug }: FacetNavProps) {
  const byKind = facetSlugsByKind(stateSlug);
  // A state with no region map (everything outside MA/CT today) simply shows
  // no region group rather than an empty heading.
  const regions = byKind.region
    .map((slug) => ({ slug, label: findRegion(stateSlug, slug)?.label ?? slug }))
    .filter((r) => r.label !== r.slug);

  return (
    <section
      className="mt-10 rounded-lg border border-border bg-muted/40 p-5"
      aria-labelledby="facet-nav-heading"
    >
      <h2 id="facet-nav-heading" className="text-lg font-bold text-foreground">
        Browse {stateName} fairs &amp; festivals
      </h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <Group
          heading="By month"
          links={byKind.month.map((slug) => ({ slug, label: MONTH_LABELS[slug] ?? slug }))}
          stateSlug={stateSlug}
          currentFacetSlug={currentFacetSlug}
        />
        {regions.length > 0 && (
          <Group
            heading="By region"
            links={regions}
            stateSlug={stateSlug}
            currentFacetSlug={currentFacetSlug}
          />
        )}
        <Group
          heading="By type"
          links={Object.entries(TYPE_FACETS).map(([slug, t]) => ({ slug, label: t.label }))}
          stateSlug={stateSlug}
          currentFacetSlug={currentFacetSlug}
        />
        <Group
          heading="Happening soon"
          links={[{ slug: "this-weekend", label: "This weekend" }]}
          stateSlug={stateSlug}
          currentFacetSlug={currentFacetSlug}
        />
      </div>
    </section>
  );
}
