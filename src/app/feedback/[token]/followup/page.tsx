/**
 * Follow-up form for sender feedback (Phase D.3.3). Reached from
 * /feedback/[token]?v=wrong_intent or v=needs_fixing. Pre-fills the
 * intent picker (for wrong_intent) or just collects free-text (for
 * needs_fixing). Token is verified-not-used here; consumed at POST.
 */

import Link from "next/link";
import { getCloudflareDb } from "@/lib/cloudflare";
import { verifyTokenForRead } from "@/lib/feedback-tokens";

export const runtime = "edge";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ v?: string }>;
}

// Same intent-picker values as the classifier — match
// mcp-server/src/email-intents.ts user-visible subset.
const SENDER_INTENT_CHOICES: { value: string; label: string }[] = [
  { value: "new_event", label: "Submitting a new event" },
  { value: "source_suggestion", label: "Suggesting a website / source for us to harvest" },
  { value: "correction", label: "Fixing details on an existing event" },
  { value: "claim_request", label: "Claiming I'm the organizer of an event" },
  { value: "vendor_inquiry", label: "Vendor question (how to list, apply, etc.)" },
  { value: "support", label: "General help / question" },
  { value: "press", label: "Media / press inquiry" },
];

export default async function FollowupPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { v: value } = await searchParams;

  const verified = await verifyTokenForRead(getCloudflareDb(), token);
  if (!verified) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <div className="rounded-lg border border-red-200 bg-red-50 p-8">
          <h1 className="text-xl font-semibold text-red-900">Link expired or already used</h1>
          <p className="mt-3 text-red-800">
            This feedback link has either been used already or is older than 60 days. Please reply
            to the original email if you have more to share.
          </p>
        </div>
      </div>
    );
  }

  const wantsIntentPicker = value === "wrong_intent";
  const wantsCorrection = value === "needs_fixing";
  if (!wantsIntentPicker && !wantsCorrection) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <div className="rounded-lg border border-red-200 bg-red-50 p-8">
          <h1 className="text-xl font-semibold text-red-900">Unknown follow-up</h1>
          <p className="mt-3 text-red-800">
            This URL doesn&apos;t look like a valid follow-up link. Please reply to the original
            email instead.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">
          {wantsIntentPicker ? "What did you mean to send?" : "Tell us what needs fixing"}
        </h1>
        <p className="mt-2 text-gray-600">
          {wantsIntentPicker
            ? "We classified this message but it sounds like we got it wrong. Help us route it to the right place."
            : "Briefly describe what's wrong on the listing — even one sentence helps."}
        </p>
        <form
          method="post"
          action={`/api/feedback/${encodeURIComponent(token)}/followup`}
          className="mt-6 space-y-4"
        >
          <input type="hidden" name="v" value={value} />
          {wantsIntentPicker && (
            <div>
              <label htmlFor="intent" className="block text-sm font-medium text-gray-700">
                What were you trying to do?
              </label>
              <select
                id="intent"
                name="intendedIntent"
                required
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
                defaultValue=""
              >
                <option value="" disabled>
                  — pick one —
                </option>
                {SENDER_INTENT_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="freeText" className="block text-sm font-medium text-gray-700">
              {wantsIntentPicker ? "Anything else to add? (optional)" : "What needs to change?"}
            </label>
            <textarea
              id="freeText"
              name="freeText"
              rows={4}
              maxLength={1000}
              required={wantsCorrection}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>
          <button
            type="submit"
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Send feedback
          </button>
          <p className="text-sm text-gray-500">
            <Link href="/" className="hover:underline">
              ← Back to Meet Me at the Fair
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
