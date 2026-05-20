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
      <div className="rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Thanks for the feedback!</h1>
        <p className="mt-3 text-gray-600">
          We use this directly to improve how we handle future submissions. Reply to the original
          email if anything else comes up.
        </p>
        <p className="mt-6 text-sm text-gray-500">
          <Link href="/" className="text-blue-600 hover:underline">
            ← Back to Meet Me at the Fair
          </Link>
        </p>
      </div>
    </div>
  );
}
