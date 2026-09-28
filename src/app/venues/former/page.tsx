/**
 * OPE-1181 — the "Former venues" index: one overall page (the simpler of the
 * ticket's two options; per-state pages can follow if the list grows).
 *
 * Lists only FORMER venues whose page is indexable (cited history — the same
 * `indexableVenueWhere()` the sitemap uses), so every link here is a page that
 * search engines may index. With none to list the page is `noindex`.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { and, asc, eq } from "drizzle-orm";
import { edtfRangeLabel } from "@takemetothefair/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { indexableVenueWhere } from "@/lib/venues/venue-history-public";
import { displayVenueName } from "@/lib/venue-display";

export const revalidate = 3600;

async function loadFormerVenues() {
  const db = getCloudflareDb();
  return db
    .select({
      slug: venues.slug,
      name: venues.name,
      address: venues.address,
      city: venues.city,
      state: venues.state,
      useStartedEdtf: venues.useStartedEdtf,
      useEndedEdtf: venues.useEndedEdtf,
    })
    .from(venues)
    .where(and(eq(venues.status, "FORMER"), indexableVenueWhere()))
    .orderBy(asc(venues.state), asc(venues.city), asc(venues.name));
}

export async function generateMetadata(): Promise<Metadata> {
  const rows = await loadFormerVenues();
  return {
    title: "Former fairgrounds and event venues | Meet Me at the Fair",
    description:
      "Fairgrounds and event venues in New England that no longer host events — when they were used, what they are now, and where their events went. Every claim is sourced.",
    alternates: { canonical: "https://meetmeatthefair.com/venues/former" },
    ...(rows.length === 0 ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function FormerVenuesPage() {
  const rows = await loadFormerVenues();
  const byState = new Map<string, typeof rows>();
  for (const r of rows) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <h1 className="text-3xl font-bold text-foreground">Former fairgrounds and event venues</h1>
      <p className="text-muted-foreground">
        Places in New England that once hosted fairs and events and no longer do. Each page says
        when the site was used, what it is now, and where its events went — with a source for every
        claim.
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">No former venues are documented yet.</p>
      ) : (
        [...byState.entries()].map(([state, list]) => (
          <section key={state}>
            <h2 className="text-xl font-semibold text-foreground mb-2">{state}</h2>
            <ul className="space-y-1">
              {list.map((v) => (
                <li key={v.slug}>
                  <Link
                    href={`/venues/${v.slug}`}
                    className="text-royal hover:text-navy font-medium"
                  >
                    {displayVenueName(v)}
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}
                    · {v.city}
                    {edtfRangeLabel(v.useStartedEdtf, v.useEndedEdtf) &&
                      ` · ${edtfRangeLabel(v.useStartedEdtf, v.useEndedEdtf)}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
