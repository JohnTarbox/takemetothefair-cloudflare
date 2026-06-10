import type { Metadata } from "next";
import { CategoryEventsPage } from "@/components/events/category-events-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Craft Shows in New England | Meet Me at the Fair",
  description:
    "Discover juried craft shows and artisan exhibitions featuring handmade goods, pottery, jewelry, and fine art across New England.",
  alternates: { canonical: "https://meetmeatthefair.com/events/craft-shows" },
  openGraph: {
    title: "Craft Shows in New England",
    description: "Discover juried craft shows and artisan exhibitions across New England.",
    url: "https://meetmeatthefair.com/events/craft-shows",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Craft Shows in New England",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Craft Shows in New England",
    description: "Discover juried craft shows and artisan exhibitions across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function CraftShowsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <CategoryEventsPage categorySlug="craft-shows" searchParams={params} />;
}
