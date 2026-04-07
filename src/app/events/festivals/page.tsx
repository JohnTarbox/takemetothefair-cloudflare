import type { Metadata } from "next";
import { CategoryEventsPage } from "@/components/events/category-events-page";

export const runtime = "edge";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Festivals in New England | Meet Me at the Fair",
  description:
    "Discover music festivals, food festivals, harvest celebrations, and cultural festivals across Maine, Vermont, New Hampshire, and Massachusetts.",
  alternates: { canonical: "https://meetmeatthefair.com/events/festivals" },
  openGraph: {
    title: "Festivals in New England",
    description:
      "Discover music festivals, food festivals, and cultural festivals across New England.",
    url: "https://meetmeatthefair.com/events/festivals",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Festivals in New England",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Festivals in New England",
    description:
      "Discover music festivals, food festivals, and cultural festivals across New England.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function FestivalsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <CategoryEventsPage categorySlug="festivals" searchParams={params} />;
}
