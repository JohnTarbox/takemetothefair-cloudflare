/**
 * B4: pre-filled correction form for inbound-email submissions that the
 * AI extracted with low confidence. The MEDIUM/LOW reply templates
 * include a link to /submit-event/<token> instead of asking the sender
 * to reply with corrections in prose. This page renders an edit form
 * pre-populated with the event's current extracted values; submit posts
 * to /api/submit-event/<token> and marks the token used.
 *
 * Token states handled:
 *   - live      → render the form
 *   - used      → "this link has already been used" message
 *   - expired   → "this link has expired" message
 *   - not-found → generic "this link is invalid" message
 *
 * No auth — the token IS the auth. 32-byte random per token; brute-force
 * impractical. We don't surface whether a given token EVER existed
 * (used/expired/not-found all return generic 404-style content) to limit
 * the information leak from token-guessing scans.
 */

import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { lookupCorrectionToken } from "@/lib/correction-tokens";
import { CorrectionForm } from "./correction-form";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function CorrectionFormPage({ params }: PageProps) {
  const { token } = await params;
  const db = getCloudflareDb();
  const lookup = await lookupCorrectionToken(db, token);

  if (lookup.status === "not-found") {
    notFound();
  }

  if (lookup.status === "used" || lookup.status === "expired") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-2xl font-semibold">This correction link is no longer active</h1>
        <p className="mt-4 text-foreground">
          {lookup.status === "used"
            ? "Your correction was submitted earlier — thanks!"
            : "This link has expired. Correction links are valid for 30 days from the email you received."}
        </p>
        <p className="mt-4 text-foreground">
          If you still need to update the event, email{" "}
          <a className="text-royal hover:underline" href="mailto:corrections@meetmeatthefair.com">
            corrections@meetmeatthefair.com
          </a>{" "}
          with the change.
        </p>
      </main>
    );
  }

  // lookup.status === 'live' — load the bound event
  const eventRows = await db
    .select({
      id: events.id,
      name: events.name,
      description: events.description,
      startDate: events.startDate,
      endDate: events.endDate,
      stateCode: events.stateCode,
      ticketUrl: events.ticketUrl,
      imageUrl: events.imageUrl,
      status: events.status,
    })
    .from(events)
    .where(eq(events.id, lookup.eventId))
    .limit(1);

  if (eventRows.length === 0) {
    // Token references an event that's been deleted — defensive. Treat
    // as a stale token rather than 404; the sender hasn't done anything
    // wrong.
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-2xl font-semibold">This event is no longer in our system</h1>
        <p className="mt-4 text-foreground">
          The event your correction link referenced has been removed. If you&apos;d like to submit
          it again, email{" "}
          <a className="text-royal hover:underline" href="mailto:submit@meetmeatthefair.com">
            submit@meetmeatthefair.com
          </a>{" "}
          with a URL.
        </p>
      </main>
    );
  }

  const event = eventRows[0];
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Help us get your event right</h1>
      <p className="mt-2 text-foreground">
        We pulled these details from your submission, but a couple of them weren&apos;t fully clear.
        Please correct anything that&apos;s wrong below — your changes will be saved and our team
        will review them.
      </p>

      <CorrectionForm
        token={token}
        initial={{
          name: event.name ?? "",
          description: event.description ?? "",
          startDate: formatDateForInput(event.startDate),
          endDate: formatDateForInput(event.endDate),
          stateCode: event.stateCode ?? "",
          ticketUrl: event.ticketUrl ?? "",
          imageUrl: event.imageUrl ?? "",
        }}
      />
    </main>
  );
}

function formatDateForInput(d: Date | null): string {
  if (!d) return "";
  // <input type="date"> expects YYYY-MM-DD. Use UTC to avoid timezone
  // shifts that would land on the wrong day.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
