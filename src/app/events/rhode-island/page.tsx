import type { Metadata } from "next";
import { StateEventsPage, getStateMetadata } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return getStateMetadata("rhode-island");
}

export default async function RhodeIslandEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="rhode-island" searchParams={params} />;
}
