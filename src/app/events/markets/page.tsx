import type { Metadata } from "next";
import { CategoryEventsPage } from "@/components/events/category-events-page";

export const runtime = "edge";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Markets in New England | Meet Me at the Fair",
  description:
    "Discover open-air markets, flea markets, and specialty markets featuring unique goods and local products across New England.",
  alternates: { canonical: "https://meetmeatthefair.com/events/markets" },
  openGraph: {
    title: "Markets in New England",
    description:
      "Discover open-air markets, flea markets, and specialty markets across New England.",
    url: "https://meetmeatthefair.com/events/markets",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Markets in New England",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Markets in New England",
    description:
      "Discover open-air markets, flea markets, and specialty markets across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <CategoryEventsPage categorySlug="markets" searchParams={params} />;
}
