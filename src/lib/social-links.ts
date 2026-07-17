/**
 * OPE-171 — single source of truth for MMATF's OWN social accounts. Drives the
 * global footer links, the Organization JSON-LD `sameAs`, AND the newsletter
 * email footer. Only include accounts MMATF actually owns: a footer link or
 * `sameAs` to an unowned handle sends our own visitors to a stranger and
 * mis-signals brand identity to Google.
 *
 * To add a platform: add ONE entry to `SOCIAL_LINKS` — it appears in the site
 * footer, `sameAs`, and the email footer automatically.
 */
export interface SocialLink {
  platform: string;
  /** Accessible label for the footer anchor. */
  label: string;
  /**
   * Short display name for contexts that render text instead of the icon —
   * currently the newsletter email footer, because Gmail strips inline <svg>
   * and an icon-only email footer renders as a blank gap there (OPE-235).
   */
  name: string;
  href: string;
  /** SVG path (viewBox "0 0 24 24") for the footer icon. */
  iconPath: string;
}

const FACEBOOK_ICON =
  "M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z";

/**
 * Instagram icon path. NOTE the owned handle is `meet.me.at.the.fair` (WITH
 * dots). The dotless `@meetmeatthefair` IG handle belongs to a third party and
 * must never be linked (OPE-171 removed it; OPE-235 added the real one).
 * Facebook's handle IS dotless — that collision is why the regression test
 * scopes its "wrong handle" assertion to instagram.com specifically.
 */
export const INSTAGRAM_ICON =
  "M12.315 2c2.43 0 2.784.013 3.808.06 1.064.049 1.791.218 2.427.465a4.902 4.902 0 011.772 1.153 4.902 4.902 0 011.153 1.772c.247.636.416 1.363.465 2.427.048 1.067.06 1.407.06 4.123v.08c0 2.643-.012 2.987-.06 4.043-.049 1.064-.218 1.791-.465 2.427a4.902 4.902 0 01-1.153 1.772 4.902 4.902 0 01-1.772 1.153c-.636.247-1.363.416-2.427.465-1.067.048-1.407.06-4.123.06h-.08c-2.643 0-2.987-.012-4.043-.06-1.064-.049-1.791-.218-2.427-.465a4.902 4.902 0 01-1.772-1.153 4.902 4.902 0 01-1.153-1.772c-.247-.636-.416-1.363-.465-2.427-.047-1.024-.06-1.379-.06-3.808v-.63c0-2.43.013-2.784.06-3.808.049-1.064.218-1.791.465-2.427a4.902 4.902 0 011.153-1.772A4.902 4.902 0 015.45 2.525c.636-.247 1.363-.416 2.427-.465C8.901 2.013 9.256 2 11.685 2h.63zm-.081 1.802h-.468c-2.456 0-2.784.011-3.807.058-.975.045-1.504.207-1.857.344-.467.182-.8.398-1.15.748-.35.35-.566.683-.748 1.15-.137.353-.3.882-.344 1.857-.047 1.023-.058 1.351-.058 3.807v.468c0 2.456.011 2.784.058 3.807.045.975.207 1.504.344 1.857.182.466.399.8.748 1.15.35.35.683.566 1.15.748.353.137.882.3 1.857.344 1.054.048 1.37.058 4.041.058h.08c2.597 0 2.917-.01 3.96-.058.976-.045 1.505-.207 1.858-.344.466-.182.8-.398 1.15-.748.35-.35.566-.683.748-1.15.137-.353.3-.882.344-1.857.048-1.055.058-1.37.058-4.041v-.08c0-2.597-.01-2.917-.058-3.96-.045-.976-.207-1.505-.344-1.858a3.097 3.097 0 00-.748-1.15 3.098 3.098 0 00-1.15-.748c-.353-.137-.882-.3-1.857-.344-1.023-.047-1.351-.058-3.807-.058zM12 6.865a5.135 5.135 0 110 10.27 5.135 5.135 0 010-10.27zm0 1.802a3.333 3.333 0 100 6.666 3.333 3.333 0 000-6.666zm5.338-3.205a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4z";

export const SOCIAL_LINKS: SocialLink[] = [
  {
    platform: "facebook",
    label: "Follow us on Facebook",
    name: "Facebook",
    href: "https://facebook.com/meetmeatthefair",
    iconPath: FACEBOOK_ICON,
  },
  {
    platform: "instagram",
    label: "Follow us on Instagram",
    name: "Instagram",
    href: "https://instagram.com/meet.me.at.the.fair",
    iconPath: INSTAGRAM_ICON,
  },
];
