import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getVendorEventsData } from "@/lib/vendors/vendor-events";
import { VendorEventsClient } from "./VendorEventsClient";

// OPE-40 — server-rendered so the event links are in the SSR HTML (crawlable),
// replacing the prior client-only useEffect fetch. Interactive filtering stays
// client-side in VendorEventsClient.
export const revalidate = 3600;

// Shared per-request so generateMetadata + the page issue a single query.
const loadData = cache((slug: string) => getVendorEventsData(getCloudflareDb(), slug));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadData(slug);
  const name = data?.vendor.displayName ?? data?.vendor.businessName ?? "Vendor";
  return {
    title: `Events for ${name} | Meet Me at the Fair`,
    description: `Upcoming and past events featuring ${name} on Meet Me at the Fair.`,
    alternates: { canonical: `/vendors/${slug}/events` },
  };
}

export default async function VendorEventsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loadData(slug);
  if (!data) notFound();
  return <VendorEventsClient vendor={data.vendor} events={data.events} slug={slug} />;
}
