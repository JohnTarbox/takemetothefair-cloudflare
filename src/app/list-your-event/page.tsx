import type { Metadata } from "next";
import Link from "next/link";
import { ListEventForm } from "./list-event-form";

/**
 * OPE-1558 — the no-login "List your fair free" form.
 *
 * ⚠️ NOINDEX ON PURPOSE, for now. OPE-1559 owns this URL's SEO landing copy,
 * the per-state variants, the sitemap entry and the primary-nav CTA, and that
 * ticket is gated on John's nod for any customer-facing nav or SERP-title
 * change. Shipping an indexable title here would be that change by the back
 * door. When OPE-1559 lands, it flips `robots` and adds the sitemap row.
 *
 * Public CSP (not a nonce route): next.config's public policy already allows
 * challenges.cloudflare.com for script + frame, which is all Turnstile needs,
 * and keeping it off the nonce list leaves OPE-1559 free to render this page
 * statically.
 */
export const metadata: Metadata = {
  title: "List Your Event Free | Meet Me at the Fair",
  description:
    "Running a fair, festival or craft show in New England? List it free on Meet Me at the Fair — one short form, no account needed.",
  alternates: { canonical: "https://meetmeatthefair.com/list-your-event" },
  robots: { index: false, follow: true },
  openGraph: {
    title: "List Your Event Free | Meet Me at the Fair",
    description: "List your fair, festival or craft show free — one short form, no account needed.",
    url: "https://meetmeatthefair.com/list-your-event",
    siteName: "Meet Me at the Fair",
    type: "website",
    // Next does not deep-merge nested openGraph — re-declare the share image.
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default function ListYourEventPage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-8 sm:py-12">
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">List your event free</h1>
      <p className="mt-2 text-foreground">
        Fairs, festivals, craft shows, school and church fairs — if it&apos;s in New England and
        open to the public, it belongs here. Fill in what you know; we&apos;ll do the rest.
      </p>
      <div className="mt-6">
        <ListEventForm />
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        Have a web page for it? You can also{" "}
        <Link href="/suggest-event" className="text-royal hover:underline">
          paste a link
        </Link>{" "}
        and we&apos;ll fill the details in from the page.
      </p>
    </main>
  );
}
