import type { Metadata } from "next";
import { StateEventsPage, getStateMetadata } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return getStateMetadata("massachusetts");
}

export default async function MassachusettsEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="massachusetts" searchParams={params} />;
}
