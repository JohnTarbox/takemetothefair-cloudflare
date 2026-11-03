import type { Metadata } from "next";

// OPE-43 (crawl hygiene) — reset-password/[token]/page.tsx is a "use client"
// component and therefore cannot export `metadata`. This server layout attaches
// robots noindex/nofollow so the auth/action page (and every tokenised URL
// under it) stays out of the index.
export const metadata: Metadata = {
  title: "Choose a new password | Meet Me at the Fair",
  description: "Set a new password for your Meet Me at the Fair account.",
  robots: { index: false, follow: false },
};

// OPE-1380 — a nonce-CSP route (src/lib/csp.ts): it must render per request,
// or the HTML carries no nonce and every script on it is blocked. Guarded by
// scripts/check-nonce-csp-routes.ts.
export const dynamic = "force-dynamic";

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
