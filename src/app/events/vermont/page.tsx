import type { Metadata } from "next";
import { StateEventsPage } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Fairs & Festivals in Vermont | Meet Me at the Fair",
  description:
    "Discover upcoming fairs, festivals, craft shows, farmers markets, and community events across Vermont. Browse by date, venue, and category.",
  alternates: {
    canonical: "https://meetmeatthefair.com/events/vermont",
  },
  openGraph: {
    title: "Fairs & Festivals in Vermont",
    description:
      "Discover upcoming fairs, festivals, craft shows, and markets across Vermont.",
    url: "https://meetmeatthefair.com/events/vermont",
  },
};

export default async function VermontEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="vermont" searchParams={params} />;
}
