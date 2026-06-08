import Link from "next/link";
import { Search, UserCircle, Calendar, Sparkles, ArrowRight, CheckCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Metadata } from "next";
import { WebPageSchema } from "@/components/seo/WebPageSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";

export const runtime = "edge";
export const revalidate = 86400;

export const metadata: Metadata = {
  title: "For Vendors — Claim Your Free Listing | Meet Me at the Fair",
  description:
    "Claim your free vendor listing on Meet Me at the Fair: add photos, list your events, keep your info accurate. No paid tiers, no upsell.",
  alternates: { canonical: "https://meetmeatthefair.com/for-vendors" },
  openGraph: {
    title: "For Vendors — Claim Your Free Listing | Meet Me at the Fair",
    description: "Claim your free vendor listing on Meet Me at the Fair. No paid tiers.",
    url: "https://meetmeatthefair.com/for-vendors",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — For Vendors",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "For Vendors — Claim Your Free Listing | Meet Me at the Fair",
    description: "Claim your free vendor listing on Meet Me at the Fair. No paid tiers.",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default function ForVendorsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "For Vendors", url: "https://meetmeatthefair.com/for-vendors" },
        ]}
      />
      <WebPageSchema
        name="For Vendors | Meet Me at the Fair"
        description="Claim your free vendor listing on Meet Me at the Fair."
        url="https://meetmeatthefair.com/for-vendors"
      />

      {/* UX-A2 Part C (2026-06-08) — single above-fold primary CTA per
          MMATF-UIUX-VendorClaim-Spec. Reframed around the FREE-claim
          flow + Maine Cardworks as social proof. Zero pricing/tier
          content (per the spec's hard guardrail — paid tiers live in
          a separate backlog item). */}
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold text-foreground mb-3">Claim Your Free Vendor Listing</h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-6">
          Add photos, list the events you&apos;ll be at, keep your contact info accurate — so
          customers find you when they&apos;re looking.{" "}
          <strong className="text-foreground">No paid tiers.</strong>
        </p>
        <Link
          href="/vendors"
          className="inline-flex items-center gap-2 px-6 py-3 bg-amber text-primary-foreground font-semibold rounded-lg hover:bg-amber/90 transition-colors text-lg"
        >
          <Search className="w-5 h-5" aria-hidden="true" />
          Find your business &amp; claim it free
          <ArrowRight className="w-5 h-5" aria-hidden="true" />
        </Link>
        <p className="text-sm text-muted-foreground mt-3">
          Already not in the directory?{" "}
          <Link
            href="/register?role=VENDOR"
            className="font-medium text-royal hover:text-navy underline"
          >
            List your business free
          </Link>
        </p>
      </div>

      {/* Social proof — Maine Cardworks is currently the one claimed vendor
          (out of 2,533) per the spec's data motivation. Pointing visitors
          at a fully-built example shows what they get when they claim. */}
      <Card className="mb-10 border-amber-dark/30 bg-amber-light">
        <CardContent className="p-6 flex items-start gap-4">
          <Sparkles className="w-6 h-6 text-amber-dark flex-shrink-0 mt-1" aria-hidden="true" />
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-foreground mb-1">
              What a claimed listing looks like
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              See{" "}
              <Link
                href="/vendors/maine-cardworks"
                className="font-medium text-royal hover:text-navy underline"
              >
                Maine Cardworks
              </Link>{" "}
              — a claimed vendor with photos, business details, and event history. This is what your
              page can look like in a few minutes, free.
            </p>
            <Link
              href="/vendors/maine-cardworks"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-royal hover:text-navy"
            >
              View example
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Benefit cards reframed around the FREE experience. Previously
          the cards were "Find Events / Build Profile / Apply / Grow Business"
          which conflated the directory's broader value with the
          specific free-claim value. New framing matches the spec's
          "be discovered, keep info accurate, show your event schedule". */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <CheckCircle className="w-6 h-6 text-sage-700" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-foreground">Be discovered</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Show up when fairgoers search for what you sell. Your listing already exists in our
              directory — claim it to take control of how it looks.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <UserCircle className="w-6 h-6 text-royal" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-foreground">Keep info accurate</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Update your description, contact info, website, and social links anytime. No waiting
              on us to re-scrape outdated data.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <Calendar className="w-6 h-6 text-terracotta" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-foreground">Show your schedule</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              List the fairs and events you&apos;ll be at this season. Repeat customers can find you
              between shows.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Secondary CTA block — same call as the hero CTA, restated at
          the bottom for users who scrolled past without clicking. */}
      <div className="bg-muted rounded-xl p-8 text-center">
        <h2 className="text-2xl font-bold text-foreground mb-3">Ready to claim your listing?</h2>
        <p className="text-muted-foreground mb-6 max-w-xl mx-auto">
          Search for your business in our directory and click &quot;Claim this free listing&quot;.
          Takes about 2 minutes.
        </p>
        <Link
          href="/vendors"
          className="inline-flex items-center gap-2 px-6 py-3 bg-amber text-primary-foreground font-semibold rounded-lg hover:bg-amber/90 transition-colors"
        >
          <Search className="w-5 h-5" aria-hidden="true" />
          Search the directory
        </Link>
        <p className="text-sm text-muted-foreground mt-6">
          Want a walkthrough?{" "}
          <Link href="/vendor-guide" className="font-medium text-royal hover:text-navy underline">
            Read the Vendor Guide
          </Link>{" "}
          — how to claim or create a listing, verify your email, and edit your profile.
        </p>
      </div>
    </div>
  );
}
