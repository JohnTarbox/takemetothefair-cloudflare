import type { Metadata } from "next";
import Link from "next/link";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  getVendorBrowseEntries,
  groupByInitial,
  groupByState,
  BROWSE_LETTERS,
  stateLabel,
  stateSlug,
} from "@/lib/browse/directory";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const revalidate = 3600; // 1 hour

export const metadata: Metadata = {
  title: "Browse All Vendors A–Z & by State | Meet Me at the Fair",
  description:
    "Browse every fair, festival, and market vendor alphabetically or by state. A complete directory of vendors on Meet Me at the Fair.",
  alternates: { canonical: "/vendors/browse" },
};

/** URL token for a first-letter bucket: "A".."Z" -> "a".."z", "#" -> "other". */
export function letterToken(bucket: string): string {
  return bucket === "#" ? "other" : bucket.toLowerCase();
}

export default async function VendorBrowseIndexPage() {
  const db = getCloudflareDb();
  const entries = await getVendorBrowseEntries(db);
  const byLetter = groupByInitial(entries);
  const byState = groupByState(entries);
  const states = Array.from(byState.keys()).sort((a, b) =>
    stateLabel(a).localeCompare(stateLabel(b))
  );

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "/" },
          { name: "Vendors", url: "/vendors" },
          { name: "Browse", url: "/vendors/browse" },
        ]}
      />
      <nav className="mb-4 text-sm text-muted-foreground">
        <Link href="/vendors" className="hover:underline">
          Vendors
        </Link>{" "}
        / Browse
      </nav>

      <h1 className="text-3xl font-bold text-foreground">Browse All Vendors</h1>
      <p className="mt-2 text-muted-foreground">
        {entries.length.toLocaleString()} vendors — browse alphabetically or by state.
      </p>

      {/* A–Z index */}
      <h2 className="mt-8 text-xl font-semibold text-foreground">By name (A–Z)</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {BROWSE_LETTERS.map((bucket) => {
          const count = byLetter.get(bucket)?.length ?? 0;
          const label = bucket === "#" ? "#" : bucket;
          return count > 0 ? (
            <Link
              key={bucket}
              href={`/vendors/browse/letter/${letterToken(bucket)}`}
              className="inline-flex h-10 min-w-10 items-center justify-center rounded-lg border border-border px-3 font-medium text-navy hover:bg-muted"
            >
              {label}
            </Link>
          ) : (
            <span
              key={bucket}
              className="inline-flex h-10 min-w-10 items-center justify-center rounded-lg border border-border px-3 text-muted-foreground/40"
            >
              {label}
            </span>
          );
        })}
      </div>

      {/* By state */}
      <h2 className="mt-10 text-xl font-semibold text-foreground">By state</h2>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {states.map((code) => (
          <li key={code}>
            <Link
              href={`/vendors/browse/state/${stateSlug(code)}`}
              className="text-navy hover:underline"
            >
              {stateLabel(code)}
            </Link>
            <span className="ml-1 text-sm text-muted-foreground">
              ({byState.get(code)?.length ?? 0})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
