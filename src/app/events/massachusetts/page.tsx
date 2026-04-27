import type { Metadata } from "next";
import { StateEventsPage } from "@/components/events/state-events-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Fairs & Festivals in Massachusetts | Meet Me at the Fair",
  description:
    "Discover upcoming fairs, festivals, craft shows, farmers markets, and community events across Massachusetts. Browse by date, venue, and category.",
  alternates: {
    canonical: "https://meetmeatthefair.com/events/massachusetts",
  },
  openGraph: {
    title: "Fairs & Festivals in Massachusetts",
    description:
      "Discover upcoming fairs, festivals, craft shows, and markets across Massachusetts.",
    url: "https://meetmeatthefair.com/events/massachusetts",
    siteName: "Meet Me at the Fair",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Fairs & Festivals in Massachusetts",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fairs & Festivals in Massachusetts",
    description:
      "Discover upcoming fairs, festivals, craft shows, and markets across Massachusetts.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function MassachusettsEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="massachusetts" searchParams={params} />;
}
