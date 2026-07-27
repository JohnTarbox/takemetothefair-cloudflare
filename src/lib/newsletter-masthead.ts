/**
 * OPE-234 — the "This Weekend at the Fair" masthead, as ONE piece of markup shared by
 * the digest email (`newsletterLayout` in src/lib/email/templates.ts) and the
 * public web archive (`/newsletter/[slug]`).
 *
 * Why it's shared rather than reimplemented per medium: OPE-232 branded the
 * email and the web page kept its plain <h1>, so the two immediately drifted —
 * that drift IS this ticket. Sharing only the strings (wordmark/eyebrow) would
 * still let the *styling* drift, so the whole band lives here.
 *
 * Why table markup + inline styles rather than a React component + Tailwind:
 * email clients need both (Outlook renders background colours on <td> reliably
 * and on <div> unreliably; Gmail strips <style> blocks), and the web can render
 * email-safe markup fine — the reverse is not true. So the email constraints
 * win and the web page consumes the same string.
 *
 * Returns a SELF-CONTAINED <table>, so:
 *   - the email nests it in a <td style="padding:0"> (nested tables are normal
 *     email practice), and
 *   - the web page renders it directly as a full-width band.
 *
 * The stored `newsletter_issues.html` stays inner-body-only. The masthead must
 * NOT be baked into it — the email shell adds one, so a masthead in the stored
 * content would render twice in the inbox.
 */

/**
 * Brand tokens, inlined because email cannot use CSS vars or a stylesheet.
 *
 * Exported so the digest's FOOTER band (`newsletterFooterHtml` in
 * src/lib/email/templates.ts) renders from the same constants as this masthead
 * band. OPE-232's acceptance is that the footer "mirrors the masthead
 * treatment" — sharing the token makes that true by construction instead of by
 * two hex literals that agree today and drift on the next palette tweak.
 */
export const BAND_GREEN = "#1f3a2d";
export const EYEBROW_GOLD = "#e8c86a";
export const SUBTITLE_GOLD = "#cbb87a";
/** Muted cream for secondary text ON the green band (8.3:1 on BAND_GREEN). */
export const ON_BAND_MUTED = "#D9D2C7";

/**
 * The fixed eyebrow line above the wordmark — a tagline, deliberately NOT a
 * second product name (OPE-285).
 */
export const NEWSLETTER_EYEBROW = "New England's Fair & Festival Almanac";

/**
 * THE product name of the consumer newsletter — the single source of truth for
 * every customer-facing surface that names it (masthead, /newsletter archive,
 * footer signup box, double-opt-in confirmation, help articles).
 *
 * OPE-285: three names ran simultaneously ("Weekend Fair Digest" in the
 * masthead/archive/signup, "This Weekend at the Fair" in the actual broadcast
 * subject, the Almanac line as an umbrella banner) because this constant
 * existed but its consumers re-declared the string as a literal instead of
 * importing it. A constant nobody imports is just one more copy. Import this;
 * never re-type the name.
 */
export const NEWSLETTER_NAME = "This Weekend at the Fair";

/** Default masthead wordmark; the OPE-191 vendor digest overrides it ("New This Week"). */
export const NEWSLETTER_WORDMARK = NEWSLETTER_NAME;

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the masthead band.
 *
 * @param wordmark Big title line. Defaults to NEWSLETTER_NAME.
 * @param subtitle Optional dated line under it (the issue subject/date).
 */
export function newsletterMastheadHtml(args: { wordmark?: string; subtitle?: string }): string {
  const wordmark = args.wordmark?.trim() || NEWSLETTER_WORDMARK;
  const subtitle = args.subtitle?.trim();
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
  <tr>
    <td style="background:${BAND_GREEN};padding:28px 32px;text-align:center;font-family:Georgia,'Times New Roman',serif;">
      <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${EYEBROW_GOLD};margin-bottom:8px;">${escapeHtmlText(NEWSLETTER_EYEBROW)}</div>
      <div style="font-size:30px;line-height:1.1;font-weight:700;color:#ffffff;">${escapeHtmlText(wordmark)}</div>
      ${
        subtitle
          ? `<div style="font-size:14px;color:${SUBTITLE_GOLD};margin-top:8px;">${escapeHtmlText(subtitle)}</div>`
          : ""
      }
    </td>
  </tr>
</table>`;
}
