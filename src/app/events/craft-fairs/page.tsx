import type { Metadata } from "next";
import { CategoryEventsPage } from "@/components/events/category-events-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Craft Fairs in New England | Meet Me at the Fair",
  description:
    "Discover community craft fairs with local artisans, handmade crafts, and unique gifts throughout Maine, Vermont, New Hampshire, and Massachusetts.",
  alternates: { canonical: "https://meetmeatthefair.com/events/craft-fairs" },
  openGraph: {
    title: "Craft Fairs in New England",
    description:
      "Discover community craft fairs with local artisans and handmade crafts across New England.",
    url: "https://meetmeatthefair.com/events/craft-fairs",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Craft Fairs in New England",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Craft Fairs in New England",
    description:
      "Discover community craft fairs with local artisans and handmade crafts across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function CraftFairsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <CategoryEventsPage categorySlug="craft-fairs" searchParams={params} />;
}
