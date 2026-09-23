import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getVendorBrowseEntries, withoutBrowseState } from "@/lib/browse/directory";
import { BrowseEntryList } from "@/components/browse/BrowseEntryList";

/**
 * OPE-831 (John's Option A, 2026-09-23) — vendors with no usable state.
 *
 * `groupByState` drops a vendor whose `state` is blank or not a browse code,
 * which left it on NO geographic browse page — 64 of 94 real claimed vendors
 * on 09-07. Location stays optional (a mail-order vendor has none); instead
 * those vendors are reachable here. `noindex,follow`: a thin "no location"
 * list is not a page worth ranking, but crawlers should follow it to the
 * vendor pages. Deliberately absent from every sitemap.
 */
export const revalidate = 3600;

const PAGE_SIZE = 300;

export const metadata: Metadata = {
  title: "Vendors — Location Not Set | Meet Me at the Fair",
  description: "Fair, festival, and market vendors who have not listed a state.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/vendors/browse/location-not-set" },
};

export default async function VendorLocationNotSetPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: raw } = await searchParams;
  const page = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(page) || page < 1) notFound();

  const db = getCloudflareDb();
  const all = withoutBrowseState(await getVendorBrowseEntries(db));
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (page > pages) notFound();
  const entries = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <nav className="mb-4 text-sm text-muted-foreground">
        <Link href="/vendors" className="hover:underline">
          Vendors
        </Link>{" "}
        /{" "}
        <Link href="/vendors/browse" className="hover:underline">
          Browse
        </Link>{" "}
        / Location not set
      </nav>

      <h1 className="text-3xl font-bold text-foreground">Vendors — location not set</h1>
      <p className="mt-2 text-muted-foreground">
        {all.length.toLocaleString()} vendors haven&apos;t listed a state, so they don&apos;t appear
        under any state.
        {pages > 1 && ` Page ${page} of ${pages}.`}
      </p>

      <div className="mt-6">
        <BrowseEntryList entries={entries} basePath="/vendors" />
      </div>

      {pages > 1 && (
        <nav className="mt-8 flex gap-4 text-sm" aria-label="Pagination">
          {page > 1 && (
            <Link
              href={`/vendors/browse/location-not-set?page=${page - 1}`}
              className="text-navy hover:underline"
            >
              ← Previous
            </Link>
          )}
          {page < pages && (
            <Link
              href={`/vendors/browse/location-not-set?page=${page + 1}`}
              className="text-navy hover:underline"
            >
              Next →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
