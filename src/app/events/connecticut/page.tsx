import type { Metadata } from "next";
import { StateEventsPage, getStateMetadata } from "@/components/events/state-events-page";

export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return getStateMetadata("connecticut");
}

export default async function ConnecticutEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; includePast?: string }>;
}) {
  const params = await searchParams;
  return <StateEventsPage stateSlug="connecticut" searchParams={params} />;
}
