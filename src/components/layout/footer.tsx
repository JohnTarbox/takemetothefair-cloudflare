import Link from "next/link";
import { NewsletterSignup } from "./newsletter-signup";
import { SOCIAL_LINKS } from "@/lib/social-links";

export function Footer() {
  const currentYear = new Date().getFullYear();

  const footerLinks = {
    discover: [
      { name: "Events", href: "/events" },
      { name: "All Events", href: "/events/all" },
      { name: "Maine Fairs", href: "/events/maine" },
      { name: "Vermont Fairs", href: "/events/vermont" },
      { name: "NH Fairs", href: "/events/new-hampshire" },
      { name: "MA Fairs", href: "/events/massachusetts" },
      { name: "CT Fairs", href: "/events/connecticut" },
      { name: "RI Fairs", href: "/events/rhode-island" },
      { name: "Past Events", href: "/events/past" },
      { name: "Venues", href: "/venues" },
      { name: "Vendors", href: "/vendors" },
      { name: "Performers", href: "/performers" },
      { name: "Blog", href: "/blog" },
      { name: "Suggest an Event", href: "/suggest-event" },
      { name: "Help", href: "/help" },
    ],
    forBusiness: [
      { name: "For Promoters", href: "/for-promoters" },
      { name: "For Vendors", href: "/for-vendors" },
      { name: "List Your Event", href: "/register?role=promoter" },
    ],
    company: [
      { name: "About Us", href: "/about" },
      { name: "Contact", href: "/contact" },
      // UR1 C3 (2026-06-04) — let visitors report a problem from any page.
      { name: "Report a problem", href: "/report-problem" },
      { name: "Privacy Policy", href: "/privacy" },
      { name: "Terms of Service", href: "/terms" },
    ],
  };

  return (
    <footer className="bg-footer text-footer-foreground/80">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="col-span-1">
            <Link href="/" className="text-xl font-bold text-footer-foreground">
              Meet Me at the Fair
            </Link>
            <p className="mt-4 text-sm text-footer-foreground/70">
              Discover local fairs, festivals, and community events. Connect with vendors and
              promoters in your area.
            </p>
            <div className="mt-6">
              <NewsletterSignup />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-footer-foreground uppercase tracking-wider">
              Discover
            </h3>
            <ul className="mt-4 space-y-2">
              {footerLinks.discover.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm hover:text-footer-foreground transition-colors"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-footer-foreground uppercase tracking-wider">
              For Business
            </h3>
            <ul className="mt-4 space-y-2">
              {footerLinks.forBusiness.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm hover:text-footer-foreground transition-colors"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-footer-foreground uppercase tracking-wider">
              Company
            </h3>
            <ul className="mt-4 space-y-2">
              {footerLinks.company.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm hover:text-footer-foreground transition-colors"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-footer-foreground/20 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-footer-foreground/70">
            &copy; {currentYear} Meet Me at the Fair. All rights reserved.
          </p>
          <div className="flex items-center gap-2">
            {/* External social links (OPE-171) — rendered from the SOCIAL_LINKS
                single source (src/lib/social-links.ts), which also drives the
                Organization JSON-LD sameAs. Only accounts MMATF owns are listed;
                a future Instagram is a one-entry add there. Plain <a> (not
                next/link, which is for internal routing) + aria-label + p-3
                (48px) hit area; the disable is for the svg-in-anchor rule, which
                targets NEW unlabeled patterns, not these already-labeled links. */}
            {SOCIAL_LINKS.map((social) => (
              <a
                key={social.platform}
                href={social.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-footer-foreground/70 hover:text-footer-foreground transition-colors p-3"
                aria-label={social.label}
              >
                {/* eslint-disable-next-line no-restricted-syntax */}
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d={social.iconPath} />
                </svg>
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
