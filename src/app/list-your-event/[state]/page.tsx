import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ListYourEventLanding } from "@/components/list-your-event/list-your-event-landing";
import {
  LIST_YOUR_EVENT_STATE_SLUGS,
  listYourEventDescription,
  listYourEventStateTitle,
  stateCodeForListSlug,
} from "@/lib/list-your-event/landing-content";
import { STATES } from "@/lib/states";

/**
 * OPE-1559 — /list-your-event/{state}, one per covered state (ME, NH, VT, MA,
 * CT, RI). Copy approved by John 2026-11-02. Any other slug is a 404: only the
 * six known slugs are generated, and `dynamicParams = false` refuses the rest.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return LIST_YOUR_EVENT_STATE_SLUGS.map((state) => ({ state }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string }>;
}): Promise<Metadata> {
  const { state } = await params;
  const code = stateCodeForListSlug(state);
  if (!code) return {};
  const name = STATES[code].name;
  const url = `https://meetmeatthefair.com/list-your-event/${state}`;
  const title = listYourEventStateTitle(name);
  return {
    title: { absolute: title },
    description: listYourEventDescription(name),
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description: listYourEventDescription(name),
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      images: ["https://meetmeatthefair.com/og-default.png"],
    },
  };
}

export default async function ListYourEventStatePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state } = await params;
  const code = stateCodeForListSlug(state);
  if (!code) notFound();
  return <ListYourEventLanding stateName={STATES[code].name} stateCode={code} />;
}
