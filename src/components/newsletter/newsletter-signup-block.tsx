import { Mail } from "lucide-react";
import { NewsletterSignup, type SignupAudience } from "@/components/layout/newsletter-signup";
import { NEWSLETTER_NAME, VENDOR_NEWSLETTER_NAME } from "@/lib/newsletter-masthead";

/**
 * OPE-317 — compact in-page signup block for high-traffic surfaces.
 *
 * The footer form has always existed; almost nobody scrolls to it. This is the
 * same form, the same double-opt-in, the same endpoint — placed where people
 * already are: event pages and blog posts. No new form logic, deliberately, so
 * there is exactly one subscribe path to reason about.
 *
 * `source` is required rather than defaulted. With the block on several
 * templates, a forgotten source silently attributes a signup to the wrong
 * surface, and knowing WHICH surface converts is the entire point of putting
 * it in more than one place.
 */
export function NewsletterSignupBlock({
  source,
  audience = "weekend",
}: {
  source: string;
  /** OPE-1209 — "vendor" renders the New This Week block (posts "vendor-form"). */
  audience?: SignupAudience;
}) {
  const vendor = audience === "vendor";
  return (
    <section
      aria-labelledby="newsletter-block-heading"
      className="rounded-lg border border-border bg-muted/40 p-5 my-8"
    >
      <div className="flex items-start gap-3">
        <Mail className="w-5 h-5 mt-0.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="newsletter-block-heading" className="text-base font-semibold text-foreground">
            {vendor ? VENDOR_NEWSLETTER_NAME : NEWSLETTER_NAME}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {vendor
              ? "For exhibitors: new New England shows with booth space still open — one email a week, free."
              : "What’s on across New England this weekend — one short email, every week, free."}
          </p>
          <div className="mt-3 max-w-sm">
            {/* OPE-1209 — this card already shows the name and blurb above, on a
                light surface: surface tone, and no second copy of the intro. */}
            <NewsletterSignup
              source={source}
              audience={audience}
              tone="surface"
              showIntro={false}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
