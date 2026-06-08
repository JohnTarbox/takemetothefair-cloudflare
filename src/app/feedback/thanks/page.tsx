/**
 * Generic post-feedback "thanks" confirmation. Reached from the
 * follow-up form POST redirect (Phase D.3). Static — no token,
 * no DB read.
 */

import Link from "next/link";

export const runtime = "edge";

export default function FeedbackThanksPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-foreground">Thanks for the feedback!</h1>
        <p className="mt-3 text-muted-foreground">
          We use this directly to improve how we handle future submissions. Reply to the original
          email if anything else comes up.
        </p>
        <p className="mt-6 text-sm text-muted-foreground">
          <Link href="/" className="text-royal hover:underline">
            ← Back to Meet Me at the Fair
          </Link>
        </p>
      </div>
    </div>
  );
}
