import type { Metadata } from "next";
import { ListYourEventLanding } from "@/components/list-your-event/list-your-event-landing";
import {
  LIST_YOUR_EVENT_TITLE,
  listYourEventDescription,
} from "@/lib/list-your-event/landing-content";

/**
 * OPE-1558 — the no-login "List your fair free" form.
 * OPE-1559 — now the indexable landing: John approved the SERP title,
 * description and FAQ on 2026-11-02, which flips the `noindex` #1704 shipped
 * with, and the URL is in sitemap-static.xml.
 *
 * Public CSP (not a nonce route): next.config's public policy already allows
 * challenges.cloudflare.com for script + frame, which is all Turnstile needs.
 */
const URL = "https://meetmeatthefair.com/list-your-event";

export const metadata: Metadata = {
  title: { absolute: LIST_YOUR_EVENT_TITLE },
  description: listYourEventDescription(),
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
  openGraph: {
    title: LIST_YOUR_EVENT_TITLE,
    description: listYourEventDescription(),
    url: URL,
    siteName: "Meet Me at the Fair",
    type: "website",
    // Next does not deep-merge nested openGraph — re-declare the share image.
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default function ListYourEventPage() {
  return <ListYourEventLanding />;
}
