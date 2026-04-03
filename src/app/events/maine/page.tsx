import type { Metadata } from "next";
import { StateEventsPage } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Fairs & Festivals in Maine | Meet Me at the Fair",
  description:
    "Discover upcoming fairs, festivals, craft shows, farmers markets, and community events across Maine. Browse by date, venue, and category.",
  alternates: {
    canonical: "https://meetmeatthefair.com/events/maine",
  },
  openGraph: {
    title: "Fairs & Festivals in Maine",
    description:
      "Discover upcoming fairs, festivals, craft shows, and markets across Maine.",
    url: "https://meetmeatthefair.com/events/maine",
    siteName: "Meet Me at the Fair",
    images: [{ url: "https://meetmeatthefair.com/og-default.png", width: 1200, height: 630, alt: "Meet Me at the Fair — Fairs & Festivals in Maine" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fairs & Festivals in Maine",
    description: "Discover upcoming fairs, festivals, craft shows, and markets across Maine.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default async function MaineEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="maine" searchParams={params} />;
}
