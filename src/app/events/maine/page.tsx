import type { Metadata } from "next";
import { StateEventsPage, getStateMetadata } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return getStateMetadata("maine");
}

export default async function MaineEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="maine" searchParams={params} />;
}
