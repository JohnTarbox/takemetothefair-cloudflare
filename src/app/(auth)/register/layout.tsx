import type { Metadata } from "next";

// OPE-43 (crawl hygiene) — register/page.tsx is a "use client" component and
// therefore cannot export `metadata`. This server layout attaches
// robots noindex/nofollow so the signup/action page (and the ~2,800 crawlable
// `/register?...claim=<slug>` claim links pointing at it) stay out of the index
// and don't burn crawl budget.
export const metadata: Metadata = {
  title: "Create your account | Meet Me at the Fair",
  description: "Sign up for a Meet Me at the Fair account.",
  robots: { index: false, follow: false },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
