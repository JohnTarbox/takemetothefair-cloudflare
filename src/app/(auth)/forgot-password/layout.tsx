import type { Metadata } from "next";

// OPE-43 (crawl hygiene) — forgot-password/page.tsx is a "use client" component
// and therefore cannot export `metadata`. This server layout attaches
// robots noindex/nofollow so the auth/action page stays out of the index.
export const metadata: Metadata = {
  title: "Reset your password | Meet Me at the Fair",
  description: "Request a password-reset link for your Meet Me at the Fair account.",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
