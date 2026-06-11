import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

export const metadata: Metadata = {
  title: "Thanks for reporting | Meet Me at the Fair",
  robots: { index: false, follow: true },
};

export default function ReportProblemThanksPage() {
  return (
    <div className="mx-auto max-w-xl px-4 sm:px-6 lg:px-8 py-16 text-center">
      <div className="flex justify-center mb-6">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle2 className="w-8 h-8 text-green-700" aria-hidden="true" />
        </div>
      </div>
      <h1 className="text-2xl font-bold text-navy">Thanks — we&apos;ve logged your report</h1>
      <p className="mt-3 text-foreground">
        If your report coincided with a site outage, it&apos;s been flagged HIGH priority and the
        technical team has been alerted. Otherwise we&apos;ll review it and act on what you
        described.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        We may reply directly if we need more detail — leave your email next time if you&apos;d like
        a guaranteed response.
      </p>
      <div className="mt-8">
        <Link
          href="/"
          className="inline-block px-5 py-2.5 rounded-lg bg-secondary text-secondary-foreground font-semibold hover:bg-royal/90"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
