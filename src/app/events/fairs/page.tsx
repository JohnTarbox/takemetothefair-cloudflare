import type { Metadata } from "next";
import { CategoryEventsPage } from "@/components/events/category-events-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Fairs in New England | Meet Me at the Fair",
  description:
    "Discover county fairs, agricultural fairs, and community fairs across Maine, Vermont, New Hampshire, and Massachusetts.",
  alternates: { canonical: "https://meetmeatthefair.com/events/fairs" },
  openGraph: {
    title: "Fairs in New England",
    description:
      "Discover county fairs, agricultural fairs, and community fairs across New England.",
    url: "https://meetmeatthefair.com/events/fairs",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Fairs in New England",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fairs in New England",
    description:
      "Discover county fairs, agricultural fairs, and community fairs across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function FairsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <CategoryEventsPage categorySlug="fairs" searchParams={params} />;
}
