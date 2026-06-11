import type { Metadata } from "next";

// MIG4 — suggest-event/page.tsx is a "use client" component and therefore
// cannot export `metadata`. This server layout attaches page-specific metadata
// (title, description, canonical, OG) so the page no longer inherits the
// homepage og:url/og:title from the root layout default.
export const metadata: Metadata = {
  title: "Suggest an Event | Meet Me at the Fair",
  description:
    "Know a fair, festival, or community event we're missing? Suggest it and we'll add it to Meet Me at the Fair.",
  alternates: { canonical: "https://meetmeatthefair.com/suggest-event" },
  openGraph: {
    title: "Suggest an Event | Meet Me at the Fair",
    description:
      "Know a fair, festival, or community event we're missing? Suggest it and we'll add it to Meet Me at the Fair.",
    url: "https://meetmeatthefair.com/suggest-event",
    siteName: "Meet Me at the Fair",
    type: "website",
    // Next does not deep-merge nested openGraph across segments — re-declare
    // the default share image so this page keeps an og:image.
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default function SuggestEventLayout({ children }: { children: React.ReactNode }) {
  return children;
}
