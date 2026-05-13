import type { Metadata } from "next";
import { StateEventsPage, getStateMetadata } from "@/components/events/state-events-page";

export const runtime = "edge";
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return getStateMetadata("new-hampshire");
}

export default async function NewHampshireEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="new-hampshire" searchParams={params} />;
}
