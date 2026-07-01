import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getVenueBrowseEntries, groupByState, stateLabel } from "@/lib/browse/directory";
import { BrowseEntryList } from "@/components/browse/BrowseEntryList";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string }>;
}): Promise<Metadata> {
  const { state } = await params;
  const code = state.toUpperCase();
  const label = stateLabel(code);
  return {
    title: `Venues in ${label} | Meet Me at the Fair`,
    description: `Fairgrounds, festival grounds, and event venues in ${label}, on Meet Me at the Fair.`,
    alternates: { canonical: `/venues/browse/state/${state.toLowerCase()}` },
  };
}

export default async function VenueBrowseStatePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state } = await params;
  const code = state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) notFound();

  const db = getCloudflareDb();
  const entries = groupByState(await getVenueBrowseEntries(db)).get(code) ?? [];
  if (entries.length === 0) notFound();

  const label = stateLabel(code);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "/" },
          { name: "Venues", url: "/venues" },
          { name: "Browse", url: "/venues/browse" },
          { name: label, url: `/venues/browse/state/${state.toLowerCase()}` },
        ]}
      />
      <nav className="mb-4 text-sm text-muted-foreground">
        <Link href="/venues" className="hover:underline">
          Venues
        </Link>{" "}
        /{" "}
        <Link href="/venues/browse" className="hover:underline">
          Browse
        </Link>{" "}
        / {label}
      </nav>

      <h1 className="text-3xl font-bold text-foreground">Venues in {label}</h1>
      <p className="mt-2 text-muted-foreground">{entries.length.toLocaleString()} venues</p>

      <div className="mt-6">
        <BrowseEntryList entries={entries} basePath="/venues" />
      </div>
    </div>
  );
}
