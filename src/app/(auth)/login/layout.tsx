import type { Metadata } from "next";

// OPE-43 (crawl hygiene) — login/page.tsx is a "use client" component and
// therefore cannot export `metadata`. This server layout attaches
// robots noindex/nofollow so the auth/action page stays out of the index.
export const metadata: Metadata = {
  title: "Sign in | Meet Me at the Fair",
  description: "Sign in to your Meet Me at the Fair account.",
  robots: { index: false, follow: false },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
