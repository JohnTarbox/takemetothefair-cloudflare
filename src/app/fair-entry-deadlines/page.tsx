/**
 * OPE-738 — "Fair entry deadlines closing soon": the cross-event view of
 * `event_applications`.
 *
 * OPE-709 modelled application routes as a child table specifically so that
 * "show me every New England fair whose photography entries are still open"
 * stays answerable. That query is the only reason (c) beat (b) in the ruling,
 * and until this page existed nothing asked it — the capability was reachable
 * by no reader. An event page can tell you WHERE to go; only an index can tell
 * you whether you are IN TIME.
 *
 * ⚠️ Gated behind ENTRY_DEADLINES_INDEX, default OFF. New customer-facing
 * surface — OPE-738 STOP-gates it on John's approval, so the route 404s until
 * the flag is flipped in wrangler.toml. See src/lib/flags.ts.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { EntryDeadlineBrowser } from "@/components/applications/EntryDeadlineBrowser";
import { listEntryDeadlines } from "@/lib/applications/list-entry-deadlines";
import { isEntryDeadlinesIndexEnabled } from "@/lib/flags";

const TITLE = "Fair Entry Deadlines | Meet Me at the Fair";
const DESCRIPTION =
  "Find which New England fairs still have exhibitor and competition entries open — photography, baking, quilting, livestock and more — sorted by the date entries close.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "https://meetmeatthefair.com/fair-entry-deadlines" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://meetmeatthefair.com/fair-entry-deadlines",
    siteName: "Meet Me at the Fair",
    type: "website",
    // Re-declared deliberately. Next does NOT deep-merge nested metadata across
    // segments: a child `openGraph` without `images` DROPS the root's og:image
    // entirely, so this is not duplication to be tidied away.
    images: [
      {
        url: "https://meetmeatthefair.com/og-default.png",
        width: 1200,
        height: 630,
        alt: "Meet Me at the Fair — Fair Entry Deadlines",
      },
    ],
  },
};

async function getRows() {
  const db = getCloudflareDb();
  try {
    return await listEntryDeadlines(db);
  } catch (e) {
    await logError(db, {
      message: "Error listing entry deadlines",
      error: e,
      source: "app/fair-entry-deadlines/page.tsx:getRows",
    });
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/fair-entry-deadlines/page.tsx:getRows", e);
  }
}

export default async function FairEntryDeadlinesPage() {
  if (!isEntryDeadlinesIndexEnabled()) notFound();

  const rows = await getRows();

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-10">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Fair Entry Deadlines", url: "https://meetmeatthefair.com/fair-entry-deadlines" },
        ]}
      />

      <header>
        <h1 className="flex items-center gap-2 text-3xl font-bold text-foreground">
          <CalendarClock className="w-7 h-7 text-amber-500" aria-hidden="true" />
          Fair entry deadlines
        </h1>
        <p className="mt-3 text-muted-foreground">
          Entering something to be judged — a photograph, a pie, a quilt, an animal — is a different
          thing from renting a booth, and it closes on a different schedule. Entries usually cost a
          dollar or two and close a few weeks before the fair, through a specific department.
        </p>
        <p className="mt-2 text-muted-foreground">
          This page lists every exhibitor and competition entry route we know about, across all
          fairs, sorted by when entries close.
        </p>
      </header>

      <EntryDeadlineBrowser rows={rows} />

      <p className="mt-10 text-xs text-muted-foreground">
        Deadlines are recorded from each fair&apos;s own published entry information. Always confirm
        on the fair&apos;s site before entering — departments occasionally extend or move a closing
        date without announcing it.
      </p>
    </div>
  );
}
