import type { Metadata } from "next";
import { StateEventsPage } from "@/components/events/state-events-page";

export const runtime = "edge";
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
  },
};

export default async function MassachusettsEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  return (
    <StateEventsPage stateSlug="massachusetts" searchParams={params} />
  );
}
