import type { Metadata } from "next";
import { CategoryEventsPage } from "@/components/events/category-events-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Farmers Markets in New England | Meet Me at the Fair",
  description:
    "Find fresh produce, local meats, baked goods, and artisan foods at farmers markets across Maine, Vermont, New Hampshire, and Massachusetts.",
  alternates: { canonical: "https://meetmeatthefair.com/events/farmers-markets" },
  openGraph: {
    title: "Farmers Markets in New England",
    description:
      "Find fresh produce, local meats, and artisan foods at farmers markets across New England.",
    url: "https://meetmeatthefair.com/events/farmers-markets",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Farmers Markets in New England",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Farmers Markets in New England",
    description:
      "Find fresh produce, local meats, and artisan foods at farmers markets across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function FarmersMarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <CategoryEventsPage categorySlug="farmers-markets" searchParams={params} />;
}
