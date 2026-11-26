import type { Metadata } from "next";
import { CheckCalendarForm } from "./CheckCalendarForm";

/**
 * OPE-1625 — "Check my calendar": paste a calendar address and see what our
 * reader would pick up, skip and flag, with nothing saved.
 *
 * UNPUBLISHED on purpose: `noindex`, and linked from no nav, footer or help
 * page until John approves the organizer-facing copy on OPE-1624. Top-level
 * rather than under /help/promoters/ so no help index or help sitemap lists it
 * by being its parent. The copy here is plain and factual and says nothing
 * about paid tiers (listing is free).
 */
export const metadata: Metadata = {
  title: "Check my calendar | Meet Me at the Fair",
  description: "See which events we would read from your calendar, without saving anything.",
  robots: { index: false, follow: false },
};

export default function CheckMyCalendarPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-10 space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Check my calendar</h1>
        <p className="text-muted-foreground">
          Paste the address of your events calendar: an iCal (.ics) link, a public Google or Outlook
          calendar address, a WordPress site using The Events Calendar, or an event page. We read it
          the way our calendar reader would and show you the events we would pick up, the ones we
          would skip and why, and anything that looks wrong. Nothing is saved.
        </p>
      </header>
      <CheckCalendarForm />
    </div>
  );
}
