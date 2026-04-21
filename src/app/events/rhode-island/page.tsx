import type { Metadata } from "next";
import { StateEventsPage } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Fairs & Festivals in Rhode Island | Meet Me at the Fair",
  description:
    "Discover upcoming fairs, festivals, craft shows, farmers markets, and community events across Rhode Island. Browse by date, venue, and category.",
  alternates: {
    canonical: "https://meetmeatthefair.com/events/rhode-island",
  },
  openGraph: {
    title: "Fairs & Festivals in Rhode Island",
    description:
      "Discover upcoming fairs, festivals, craft shows, and markets across Rhode Island.",
    url: "https://meetmeatthefair.com/events/rhode-island",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Fairs & Festivals in Rhode Island",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fairs & Festivals in Rhode Island",
    description:
      "Discover upcoming fairs, festivals, craft shows, and markets across Rhode Island.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function RhodeIslandEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="rhode-island" searchParams={params} />;
}
