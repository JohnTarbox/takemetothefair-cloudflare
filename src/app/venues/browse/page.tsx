import type { Metadata } from "next";
import Link from "next/link";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  getVenueBrowseEntries,
  groupByInitial,
  groupByState,
  BROWSE_LETTERS,
  stateLabel,
  stateSlug,
  letterToken,
} from "@/lib/browse/directory";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const revalidate = 3600; // 1 hour

export const metadata: Metadata = {
  title: "Browse All Venues A–Z & by State | Meet Me at the Fair",
  description:
    "Browse every fairground, festival ground, and event venue alphabetically or by state. A complete directory of venues on Meet Me at the Fair.",
  alternates: { canonical: "/venues/browse" },
};

export default async function VenueBrowseIndexPage() {
  const db = getCloudflareDb();
  const entries = await getVenueBrowseEntries(db);
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
          { name: "Venues", url: "/venues" },
          { name: "Browse", url: "/venues/browse" },
        ]}
      />
      <nav className="mb-4 text-sm text-muted-foreground">
        <Link href="/venues" className="hover:underline">
          Venues
        </Link>{" "}
        / Browse
      </nav>

      <h1 className="text-3xl font-bold text-foreground">Browse All Venues</h1>
      <p className="mt-2 text-muted-foreground">
        {entries.length.toLocaleString()} venues — browse alphabetically or by state.
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
              href={`/venues/browse/letter/${letterToken(bucket)}`}
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
              href={`/venues/browse/state/${stateSlug(code)}`}
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
