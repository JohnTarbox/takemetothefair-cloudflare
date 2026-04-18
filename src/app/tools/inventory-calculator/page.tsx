import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { InventoryCalculator } from "@/components/blog/embeds/InventoryCalculator";

export const runtime = "edge";

const title = "Craft Fair Inventory Calculator | Meet Me at the Fair";
const description =
  "Figure out how many items to bring to a craft fair based on your sales goal, product type, and fair size. Free planning tool for vendors.";
const url = "https://meetmeatthefair.com/tools/inventory-calculator";
const ogImage = "https://meetmeatthefair.com/og-default.png";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: url },
  openGraph: {
    title: "Craft Fair Inventory Calculator",
    description,
    url,
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [{ url: ogImage, width: 1200, height: 630, alt: "Craft Fair Inventory Calculator" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Craft Fair Inventory Calculator",
    description,
    images: [ogImage],
  },
};

export default function InventoryCalculatorPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <nav className="mb-6">
        <Link
          href="/blog/how-many-items-should-you-bring-to-a-craft-fair-a-simple-formula"
          className="inline-flex items-center gap-1 text-sm text-royal hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Read the full guide
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="font-display text-heading-lg text-navy">Craft Fair Inventory Calculator</h1>
        <p className="mt-2 text-stone-600">
          Enter your sales goal, what you sell, and (optionally) the fair size — the calculator
          estimates how many items to bring and how to split inventory across price tiers.
        </p>
      </header>

      <InventoryCalculator />
    </div>
  );
}
