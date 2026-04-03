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
