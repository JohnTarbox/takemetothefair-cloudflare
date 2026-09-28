"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NewsletterSignup } from "./newsletter-signup";
import { NEWSLETTER_NAME } from "@/lib/newsletter-masthead";

/**
 * OPE-1209 — the footer's signup, except where it would compete with a
 * different newsletter's form.
 *
 * The footer form is the ATTENDEE list and renders on every page. On the vendor
 * newsletter's own archive that made it the only signup a vendor saw: a reader
 * of seven vendor issues who clicked Subscribe there landed on the weekend
 * list. That page now carries the vendor form, and two forms writing to two
 * lists on one page is how people pick the wrong one — so there the footer
 * offers the attendee newsletter as a link, not a second form.
 */
export const FOOTER_FORM_SUPPRESSED_PATHS = ["/newsletter/vendor"];

export function FooterNewsletterSlot() {
  const pathname = usePathname();
  if (pathname && FOOTER_FORM_SUPPRESSED_PATHS.includes(pathname)) {
    return (
      <p className="text-sm text-footer-foreground/70">
        Planning a visit instead?{" "}
        <Link href="/newsletter" className="underline hover:text-footer-foreground">
          {NEWSLETTER_NAME}
        </Link>{" "}
        is our weekly guide for fair-goers.
      </p>
    );
  }
  return <NewsletterSignup />;
}
