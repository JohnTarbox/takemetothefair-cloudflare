/**
 * Standalone "request a fresh verification email" page. Useful when:
 *   - The dashboard banner has been dismissed
 *   - The user can't find the original verification email and doesn't
 *     remember if it's expired or just lost
 *   - The user is signed out and doesn't want to sign in first
 *
 * The vendor guide at /vendor-guide and the troubleshooting tips link
 * here for a one-stop resend surface. Mirrors the resend form on the
 * expired-link branch of /verify-email/[token] but reachable without
 * holding a token URL.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Mail } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ResendVerificationButton } from "@/components/auth/ResendVerificationButton";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Resend verification email | Meet Me at the Fair",
  description: "Request a fresh email-verification link for your Meet Me at the Fair account.",
  robots: { index: false, follow: false },
};

export default function ResendVerificationPage() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center mb-3">
            <Mail className="w-12 h-12 text-royal" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold text-center text-foreground">
            Resend verification email
          </h1>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              Enter the email you signed up with. We&apos;ll send a fresh verification link — valid
              for 24 hours.
            </p>
            <ResendVerificationButton label="Send verification email" />
            <p className="text-xs text-muted-foreground text-center pt-2">
              For security, we send the same generic response whether or not the email matches an
              account. If you don&apos;t receive a link within a few minutes, check your spam
              folder.
            </p>
            <p className="text-sm text-muted-foreground text-center pt-2">
              Already verified?{" "}
              <Link href="/login" className="text-navy hover:underline font-medium">
                Sign in
              </Link>
              .
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
