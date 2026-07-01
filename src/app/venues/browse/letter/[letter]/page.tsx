import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getVenueBrowseEntries, browseInitial, BROWSE_LETTERS } from "@/lib/browse/directory";
import { BrowseEntryList } from "@/components/browse/BrowseEntryList";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const revalidate = 3600;

/** token -> first-letter bucket: "other" -> "#", "a".."z" -> "A".."Z". */
function tokenToBucket(token: string): string | null {
  if (token === "other") return "#";
  if (/^[a-z]$/.test(token)) return token.toUpperCase();
  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ letter: string }>;
}): Promise<Metadata> {
  const { letter } = await params;
  const bucket = tokenToBucket(letter);
  if (!bucket) return { title: "Venues | Meet Me at the Fair" };
  const label = bucket === "#" ? "#" : bucket;
  return {
    title: `Venues starting with ${label} | Meet Me at the Fair`,
    description: `All fair and festival venues whose name starts with ${label}, on Meet Me at the Fair.`,
    alternates: { canonical: `/venues/browse/letter/${letter}` },
  };
}

export default async function VenueBrowseLetterPage({
  params,
}: {
  params: Promise<{ letter: string }>;
}) {
  const { letter } = await params;
  const bucket = tokenToBucket(letter);
  if (!bucket || !BROWSE_LETTERS.includes(bucket as (typeof BROWSE_LETTERS)[number])) {
    notFound();
  }

  const db = getCloudflareDb();
  const entries = (await getVenueBrowseEntries(db)).filter((e) => browseInitial(e.name) === bucket);
  const label = bucket === "#" ? "#" : bucket;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "/" },
          { name: "Venues", url: "/venues" },
          { name: "Browse", url: "/venues/browse" },
          { name: label, url: `/venues/browse/letter/${letter}` },
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

      <h1 className="text-3xl font-bold text-foreground">Venues starting with {label}</h1>
      <p className="mt-2 text-muted-foreground">{entries.length.toLocaleString()} venues</p>

      <div className="mt-6">
        <BrowseEntryList entries={entries} basePath="/venues" />
      </div>
    </div>
  );
}
