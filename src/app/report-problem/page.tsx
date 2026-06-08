import type { Metadata } from "next";
import Link from "next/link";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Report a problem | Meet Me at the Fair",
  description:
    "Tell us about a broken page, missing event, or anything else that's not working — we read every report.",
  // Reporting form: don't index these utility pages.
  robots: { index: false, follow: true },
};

interface SearchParams {
  page?: string;
  source?: string;
}

export default async function ReportProblemPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolved = await searchParams;
  // `page` query param is pre-filled by callers (not-found CTA, error
  // boundary CTA, footer "Report a problem" link from the current path)
  // so the operator sees which page the user was on.
  const prefilledPath = resolved.page ?? "";
  // `source` indicates which CTA the user came from — helpful operator
  // triage signal. Default "footer" matches the footer-link case.
  const sourceTag = resolved.source ?? "footer";

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold text-navy">Report a problem</h1>
      <p className="mt-2 text-foreground">
        Found a broken page, a missing event, or something not behaving right? Tell us about it. We
        read every report and act on the ones we can fix.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Your email is optional — leave it blank if you&apos;d rather report anonymously. We&apos;ll
        only reply if we need more detail.
      </p>

      <form action="/api/report-problem" method="POST" className="mt-8 space-y-5">
        <input type="hidden" name="source_tag" value={sourceTag} />
        {/* Honeypot — real users leave this empty. Bots fill every input. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          aria-hidden="true"
        />

        <div>
          <label htmlFor="reporter_email" className="block text-sm font-medium text-foreground">
            Your email (optional)
          </label>
          <input
            id="reporter_email"
            type="email"
            name="reporter_email"
            placeholder="you@example.com"
            className="mt-1 w-full px-3 py-2 border border-border rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
          />
        </div>

        <div>
          <label htmlFor="path" className="block text-sm font-medium text-foreground">
            Page you&apos;re reporting (optional)
          </label>
          <input
            id="path"
            type="text"
            name="path"
            defaultValue={prefilledPath}
            placeholder="/events/some-slug — leave blank if not page-specific"
            className="mt-1 w-full px-3 py-2 border border-border rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
          />
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium text-foreground">
            What&apos;s wrong? <span className="text-red-600">*</span>
          </label>
          <textarea
            id="body"
            name="body"
            required
            rows={6}
            maxLength={5000}
            placeholder="Describe what you saw, what you expected, and how to reproduce it…"
            className="mt-1 w-full px-3 py-2 border border-border rounded-lg focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
          />
        </div>

        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <button
            type="submit"
            className="px-5 py-2.5 rounded-lg bg-secondary text-secondary-foreground font-semibold hover:bg-royal/90 focus:outline-none focus:ring-2 focus:ring-royal focus:ring-offset-1 transition-colors"
          >
            Send report
          </button>
          <Link
            href="/"
            className="px-5 py-2.5 rounded-lg border border-border text-foreground font-medium text-center hover:bg-muted"
          >
            Cancel
          </Link>
        </div>
      </form>

      <p className="mt-8 text-xs text-muted-foreground">
        Prefer email? Send a note to{" "}
        <a href="mailto:report@meetmeatthefair.com" className="underline">
          report@meetmeatthefair.com
        </a>{" "}
        and we&apos;ll handle it the same way.
      </p>
    </div>
  );
}
