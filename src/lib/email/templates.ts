/**
 * Minimal transactional email templates. Inline styles so they render in all
 * clients. Kept small deliberately — real brand templates can come later when
 * we decide on a template library (React Email, MJML, etc.).
 */
import { SOCIAL_LINKS } from "@/lib/social-links";
import {
  BAND_GREEN,
  EYEBROW_GOLD,
  ON_BAND_MUTED,
  SUBTITLE_GOLD,
  newsletterMastheadHtml,
} from "@/lib/newsletter-masthead";

function baseLayout(args: {
  heading: string;
  body: string;
  cta?: { url: string; label: string };
}): string {
  const { heading, body, cta } = args;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2A2521;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FAF7F2;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #EBE5DA;">
            <tr>
              <td style="padding:32px;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#1E2761;margin-bottom:8px;">Meet Me at the Fair</div>
                <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;margin:16px 0 12px;color:#1E2761;">${heading}</h1>
                <div style="font-size:16px;line-height:1.55;color:#2A2521;">${body}</div>
                ${
                  cta
                    ? `<div style="margin-top:24px;"><a href="${cta.url}" style="display:inline-block;padding:12px 20px;background:#E8960C;color:#1E2761;font-weight:600;text-decoration:none;border-radius:8px;">${cta.label}</a></div>`
                    : ""
                }
                <hr style="border:none;border-top:1px solid #EBE5DA;margin:28px 0;" />
                <div style="font-size:13px;color:#6F6455;">
                  If you didn't expect this email, you can safely ignore it.
                </div>
              </td>
            </tr>
          </table>
          <div style="font-size:12px;color:#6F6455;margin-top:16px;">&copy; Meet Me at the Fair</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function passwordResetTemplate(args: { resetUrl: string; name: string | null }): {
  subject: string;
  html: string;
  text: string;
} {
  const greeting = args.name ? `Hi ${args.name},` : "Hi,";
  const html = baseLayout({
    heading: "Reset your password",
    body: `<p style="margin:0 0 12px;">${greeting}</p><p style="margin:0 0 12px;">We received a request to reset the password on your Meet Me at the Fair account. Click the button below to choose a new one. This link expires in 1 hour.</p>`,
    cta: { url: args.resetUrl, label: "Reset password" },
  });
  const text = `${greeting}\n\nWe received a request to reset the password on your Meet Me at the Fair account. Click the link below to choose a new one. This link expires in 1 hour.\n\n${args.resetUrl}\n\nIf you didn't expect this email, you can safely ignore it.`;
  return { subject: "Reset your Meet Me at the Fair password", html, text };
}

export function emailVerificationTemplate(args: { verifyUrl: string; name: string | null }): {
  subject: string;
  html: string;
  text: string;
} {
  const greeting = args.name ? `Hi ${args.name},` : "Hi,";
  const html = baseLayout({
    heading: "Verify your email",
    body: `<p style="margin:0 0 12px;">${greeting}</p><p style="margin:0 0 12px;">Welcome to Meet Me at the Fair. Please confirm this email address so we can keep you in the loop about events, applications, and updates. This link expires in 24 hours.</p>`,
    cta: { url: args.verifyUrl, label: "Verify email" },
  });
  const text = `${greeting}\n\nWelcome to Meet Me at the Fair. Please confirm this email address by opening the link below. It expires in 24 hours.\n\n${args.verifyUrl}\n\nIf you didn't sign up, you can safely ignore this email.`;
  return { subject: "Confirm your Meet Me at the Fair email", html, text };
}

export function vendorClaimVerificationTemplate(args: {
  businessName: string;
  verifyUrl: string;
}): { subject: string; html: string; text: string } {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = baseLayout({
    heading: "Confirm your vendor claim",
    body: `<p style="margin:0 0 12px;">You requested to claim the Meet Me at the Fair listing for <strong>${escape(args.businessName)}</strong>.</p>
<p style="margin:0 0 12px;">Click the button below to confirm. This link expires in 24 hours and can be used once.</p>
<p style="margin:0 0 12px;">If you didn't request this, no action is needed — the listing stays as it is.</p>`,
    cta: { url: args.verifyUrl, label: "Confirm claim" },
  });
  const text = `You requested to claim the Meet Me at the Fair listing for "${args.businessName}".\n\nConfirm by opening:\n${args.verifyUrl}\n\nThis link expires in 24 hours. If you didn't request this, no action is needed.`;
  return { subject: `Confirm your claim of ${args.businessName}`, html, text };
}

export function vendorClaimConfirmationTemplate(args: {
  businessName: string;
  vendorSlug: string;
  siteUrl: string;
}): { subject: string; html: string; text: string } {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const profileUrl = `${args.siteUrl}/vendor/profile`;
  const publicUrl = `${args.siteUrl}/vendors/${args.vendorSlug}`;
  const html = baseLayout({
    heading: "Your listing is now claimed",
    body: `<p style="margin:0 0 12px;">Your Meet Me at the Fair listing for <strong>${escape(args.businessName)}</strong> is now marked as Claimed.</p>
<p style="margin:0 0 12px;">A "Claimed" badge appears on your public page, signalling to event-goers that the business itself maintains this listing. Update your profile any time at <a href="${profileUrl}" style="color:#1E2761;">${profileUrl}</a>.</p>
<p style="margin:0 0 12px;">View your public page: <a href="${publicUrl}" style="color:#1E2761;">${publicUrl}</a></p>`,
    cta: { url: profileUrl, label: "Open vendor profile" },
  });
  const text = `Your Meet Me at the Fair listing for "${args.businessName}" is now marked as Claimed.\n\nA "Claimed" badge appears on your public page. Update your profile any time:\n${profileUrl}\n\nPublic page: ${publicUrl}`;
  return { subject: `Your ${args.businessName} listing is now claimed`, html, text };
}

export function promoterBlogMentionTemplate(args: {
  promoterName: string | null;
  postTitle: string;
  postUrl: string;
  eventName: string;
  eventUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = args.promoterName ? `Hi ${args.promoterName},` : "Hi,";
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = baseLayout({
    heading: "Your event was featured on our blog",
    body: `<p style="margin:0 0 12px;">${greeting}</p>
<p style="margin:0 0 12px;">We just published a blog post that mentions your event <strong>${escape(args.eventName)}</strong>:</p>
<p style="margin:0 0 12px;"><a href="${args.postUrl}" style="color:#1E2761;">${escape(args.postTitle)}</a></p>
<p style="margin:0 0 12px;">Feel free to share it — or visit <a href="${args.eventUrl}" style="color:#1E2761;">your event page</a> to see how it's being surfaced alongside related coverage.</p>`,
    cta: { url: args.postUrl, label: "Read the post" },
  });
  const text = `${greeting}\n\nWe just published a blog post that mentions your event "${args.eventName}":\n\n${args.postTitle}\n${args.postUrl}\n\nEvent page: ${args.eventUrl}\n\nFeel free to share it with your audience.`;
  return {
    subject: `"${args.postTitle}" mentions ${args.eventName}`,
    html,
    text,
  };
}

/**
 * OPE-65 — factual claim-decision notice sent to the claimant when an admin
 * approves or rejects their claim in the /admin/claims review queue. No
 * marketing copy: it states the outcome and the next step.
 *
 *   - approved: confirms they can now manage the listing + a link to the portal
 *   - rejected: states it wasn't approved, the reason, and how to follow up
 */
export function claimDecisionTemplate(args: {
  entityName: string;
  decision: "approved" | "rejected";
  reason?: string;
  manageUrl?: string;
}): { subject: string; html: string; text: string } {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const name = escape(args.entityName);

  if (args.decision === "approved") {
    const html = baseLayout({
      heading: "Your claim was approved",
      body: `<p style="margin:0 0 12px;">Your claim for <strong>${name}</strong> was approved — you can now manage the listing.</p>
<p style="margin:0 0 12px;">Sign in to update details, photos, and contact information any time.</p>`,
      cta: args.manageUrl ? { url: args.manageUrl, label: "Manage your listing" } : undefined,
    });
    const text = `Your claim for "${args.entityName}" was approved — you can now manage the listing.${
      args.manageUrl ? `\n\nManage it here:\n${args.manageUrl}` : ""
    }`;
    return { subject: `Your claim for ${args.entityName} was approved`, html, text };
  }

  const reasonBlock = args.reason
    ? `<p style="margin:0 0 12px;"><strong>Reason:</strong> ${escape(args.reason)}</p>`
    : "";
  const html = baseLayout({
    heading: "Your claim wasn't approved",
    body: `<p style="margin:0 0 12px;">Your claim for <strong>${name}</strong> wasn't approved.</p>
${reasonBlock}
<p style="margin:0 0 12px;">If you believe this is a mistake, reply to this email with additional evidence that you represent this business and we'll take another look.</p>`,
  });
  const reasonText = args.reason ? `\n\nReason: ${args.reason}` : "";
  const text = `Your claim for "${args.entityName}" wasn't approved.${reasonText}\n\nIf you believe this is a mistake, reply to this email with additional evidence that you represent this business and we'll take another look.`;
  return { subject: `Your claim for ${args.entityName} wasn't approved`, html, text };
}

/**
 * Newsletter double opt-in confirmation. Sent once on signup; link
 * expires in 14 days (OPE-168 — NEWSLETTER_CONFIRM_TTL_DAYS). The CAN-SPAM /
 * GDPR posture is "we don't add you to the list until you click" — until
 * confirmed, the row sits with `confirmed=false` and is excluded from sends.
 */
export function newsletterConfirmTemplate(args: { confirmUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const html = baseLayout({
    heading: "Confirm your subscription",
    body: `<p style="margin:0 0 12px;">Thanks for signing up for the Meet Me at the Fair weekend digest.</p>
<p style="margin:0 0 12px;">Click the button below to confirm your email and start receiving our weekly roundup of events, new vendors, and hidden gems across New England. The link is valid for 14 days.</p>
<p style="margin:0 0 12px;">If you didn't sign up, you can ignore this email — without confirming, you won't be added to the list.</p>`,
    cta: { url: args.confirmUrl, label: "Confirm subscription" },
  });
  const text = `Thanks for signing up for the Meet Me at the Fair weekend digest.\n\nClick the link below to confirm your email and start receiving our weekly roundup of events, new vendors, and hidden gems across New England. The link is valid for 14 days.\n\n${args.confirmUrl}\n\nIf you didn't sign up, you can ignore this email — without confirming, you won't be added to the list.`;
  return {
    subject: "Confirm your Meet Me at the Fair subscription",
    html,
    text,
  };
}

/**
 * OPE-169 — the weekly digest broadcast. Wraps caller-provided issue content
 * (event / vendor / featured slots) in the shared email shell, with a
 * "view in browser" link at the top and a one-click unsubscribe footer at the
 * bottom (CAN-SPAM). `unsubscribeUrl` is per-recipient (signed token);
 * `viewInBrowserUrl` is the public /newsletter/{slug} page.
 */
/**
 * OPE-232 — the newsletter-branded shell, distinct from `baseLayout` (the
 * transactional one). A digest wrapped in `baseLayout` looked like a password
 * reset: navy/orange sans-serif around green/gold serif content, a duplicate
 * subject `<h1>`, and the transactional "If you didn't expect this email…" line
 * — wrong for an opt-in newsletter.
 *
 * This is green/gold Georgia serif end-to-end: a `#1f3a2d` masthead band with a
 * gold eyebrow + wordmark, the caller's `contentHtml` on a cream body, and an
 * on-brand footer. The compliant view-in-browser link and per-recipient
 * unsubscribe (CAN-SPAM) are kept — only the visual shell changed.
 *
 * `wordmark` is parameterized so OPE-191's vendor "New This Week" digest reuses
 * this exact shell with a different masthead (scope §3).
 */
/**
 * OPE-235 — social links for the newsletter footer, sourced from SOCIAL_LINKS
 * so the site footer, Organization `sameAs`, and email never drift apart.
 *
 * Rendered as TEXT links, not the SVG `iconPath` the site footer uses: Gmail
 * strips inline <svg>, so an icon-only email footer is a blank gap for a large
 * share of recipients. Returns "" when SOCIAL_LINKS is empty so the separator
 * row never renders on its own.
 */
/**
 * Social links for the digest footer. Rendered ON the green band, so every
 * colour here is a light-on-dark pair — the pre-OPE-232-reopen version used
 * `#1f3a2d` (the band colour itself), which is invisible once the band exists.
 */
function renderNewsletterSocialLinks(): string {
  if (SOCIAL_LINKS.length === 0) return "";
  const links = SOCIAL_LINKS.map(
    (s) =>
      `<a href="${s.href}" style="color:${EYEBROW_GOLD};text-decoration:underline;">${escapeHtmlText(s.name)}</a>`
  ).join(` <span style="color:${SUBTITLE_GOLD};">&middot;</span> `);
  return `<div style="margin-top:10px;">${links}</div>`;
}

/**
 * The digest's branded footer band — the bookend to `newsletterMastheadHtml`.
 *
 * Shape mirrors the masthead deliberately (self-contained <table>, background
 * on a <td>, inline styles): Outlook honours a background colour on <td>
 * reliably and on <div> unreliably, which is why the previous flat-<div> footer
 * could not simply have a `background` added to it.
 *
 * The view-in-browser link is DUPLICATED here rather than moved. The copy above
 * the masthead is the conventional position and is the one that still works
 * when the email renders badly; this one is the one a reader actually sees,
 * because the eye lands on the branded chrome, not on a 12px line floating
 * above it (OPE-232 reopen, 2026-07-20 — John and the analyst both missed it).
 */
function newsletterFooterHtml(args: {
  unsubscribeUrl: string;
  viewInBrowserUrl: string;
  mailing: string;
}): string {
  const { unsubscribeUrl, viewInBrowserUrl, mailing } = args;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
  <tr>
    <td style="background:${BAND_GREEN};padding:24px 32px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:12px;line-height:1.6;color:${ON_BAND_MUTED};">
      <div style="font-size:16px;font-weight:700;color:#ffffff;">Meet Me at the Fair</div>
      <div style="margin-top:4px;color:${SUBTITLE_GOLD};">One email a week — New England's fairs, festivals &amp; makers markets.</div>
      ${renderNewsletterSocialLinks()}
      <div style="margin-top:12px;">
        <a href="${viewInBrowserUrl}" style="color:${EYEBROW_GOLD};text-decoration:underline;">View this email in your browser</a>
      </div>
      <div style="margin-top:8px;">
        <a href="${unsubscribeUrl}" style="color:${ON_BAND_MUTED};text-decoration:underline;">Unsubscribe</a>
      </div>
      <div style="margin-top:8px;color:${ON_BAND_MUTED};">${escapeHtmlText(mailing)}</div>
    </td>
  </tr>
</table>`;
}

/**
 * OPE-231 — the one-tap "Approve & send to everyone" banner. Rendered ONLY when
 * an `approveUrl` is threaded through (the send route passes it on the PREVIEW
 * send to John and never on a broadcast), so the button can only ever appear in
 * the email John reviews, never in the copy subscribers receive. The link is a
 * plain `<a>` to a confirmation page — no form, no side effect on load — so an
 * inbox link pre-scanner that fetches it cannot trigger a send.
 */
function newsletterApproveBannerHtml(approveUrl: string): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 24px;">
  <tr>
    <td style="background:#FBF3E4;border:1px solid ${EYEBROW_GOLD};border-radius:8px;padding:16px 20px;text-align:center;font-family:Georgia,'Times New Roman',serif;">
      <div style="font-size:13px;color:#6B5B2E;margin:0 0 12px;">This is a preview. Approving sends this exact issue to the whole subscriber list.</div>
      <a href="${approveUrl}" style="display:inline-block;background:#2e7d52;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:6px;">Approve &amp; send to everyone &rarr;</a>
    </td>
  </tr>
</table>`;
}

/**
 * OPE-284 — the honest counterpart to the approve banner, rendered on a preview
 * composed while `NEWSLETTER_SEND_ENABLED` is off.
 *
 * The defect this closes: the gate was checked only when the link was CLICKED,
 * so a preview cheerfully rendered an active "Approve & send to everyone" button
 * that the API would then refuse (John hit exactly that on 2026-07-23). An email
 * must never offer an action the system will decline — so the gate is now read at
 * COMPOSE time and the button is replaced by a statement of why it is unavailable.
 * This copy is operator-facing: the approve banner only ever ships on the preview
 * to John, never on a broadcast.
 */
function newsletterApproveDisabledBannerHtml(): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 24px;">
  <tr>
    <td style="background:#F5F1EA;border:1px solid #D8D0C4;border-radius:8px;padding:16px 20px;text-align:center;font-family:Georgia,'Times New Roman',serif;">
      <div style="font-size:13px;color:#6B6259;margin:0 0 8px;">This is a preview. <strong>Broadcast sending is currently disabled</strong>, so there is no approve button — approving would be refused.</div>
      <div style="font-size:12px;color:#8A8178;">To arm the send, set <code>NEWSLETTER_SEND_ENABLED = "true"</code> in the main app's <code>wrangler.toml</code> and redeploy, then request a fresh preview.</div>
    </td>
  </tr>
</table>`;
}

function newsletterLayout(args: {
  wordmark: string;
  /** Optional dated subtitle under the wordmark, e.g. the issue subject. */
  subtitle?: string;
  body: string;
  unsubscribeUrl: string;
  viewInBrowserUrl: string;
  mailing: string;
  /** OPE-231 — preview-only approve link. Omitted on every broadcast. */
  approveUrl?: string;
  /** OPE-284 — preview composed while the broadcast gate is off: render the
   *  disabled explanation instead of an unkeepable button. Ignored when
   *  `approveUrl` is set (a live link always wins) and on broadcasts. */
  approveDisabled?: boolean;
}): string {
  const {
    wordmark,
    subtitle,
    body,
    unsubscribeUrl,
    viewInBrowserUrl,
    mailing,
    approveUrl,
    approveDisabled,
  } = args;
  const approveBanner = approveUrl
    ? newsletterApproveBannerHtml(approveUrl)
    : approveDisabled
      ? newsletterApproveDisabledBannerHtml()
      : "";
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#FAF7F2;font-family:Georgia,'Times New Roman',serif;color:#2A2521;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FAF7F2;">
      <tr>
        <td align="center" style="padding:24px 16px;">
          <div style="width:100%;max-width:600px;text-align:center;font-size:12px;color:#8A8178;margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;">
            <a href="${viewInBrowserUrl}" style="color:#1f3a2d;">View this email in your browser</a>
          </div>
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #E5DFD6;">
            <tr>
              <td style="padding:0;">
                ${newsletterMastheadHtml({ wordmark, subtitle })}
              </td>
            </tr>
            <tr>
              <td style="padding:32px;font-size:16px;line-height:1.55;color:#2A2521;">
                ${approveBanner}${body}
              </td>
            </tr>
            <tr>
              <td style="padding:0;">
                ${newsletterFooterHtml({ unsubscribeUrl, viewInBrowserUrl, mailing })}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function newsletterDigestTemplate(args: {
  subject: string;
  /** Rendered issue body HTML (the caller builds the event/vendor/featured slots). */
  contentHtml: string;
  /** Plain-text alternative for the body; when omitted, derived by stripping tags. */
  contentText?: string;
  unsubscribeUrl: string;
  viewInBrowserUrl: string;
  /** CAN-SPAM §5(a)(5) physical postal address. Falls back to a region line. */
  mailingAddress?: string;
  /** Masthead wordmark; OPE-191's vendor digest overrides it. */
  wordmark?: string;
  /** OPE-231 — one-tap approve link; set only on the preview to John. */
  approveUrl?: string;
  /** OPE-284 — preview composed while the broadcast gate is off; renders the
   *  disabled explanation in place of the approve button. */
  approveDisabled?: boolean;
}): { subject: string; html: string; text: string } {
  const mailing = args.mailingAddress?.trim() || "Meet Me at the Fair, New England";
  const html = newsletterLayout({
    wordmark: args.wordmark?.trim() || "Weekend Fair Digest",
    // The subject carries the date ("Weekend Fair Digest — July 12–13"); show it
    // as a subtitle rather than a duplicate <h1> (scope §1).
    subtitle: args.subject,
    body: args.contentHtml,
    unsubscribeUrl: args.unsubscribeUrl,
    viewInBrowserUrl: args.viewInBrowserUrl,
    mailing,
    approveUrl: args.approveUrl,
    approveDisabled: args.approveDisabled,
  });

  const bodyText =
    args.contentText ??
    args.contentHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const text = `${args.subject}\n\nView this issue in your browser: ${args.viewInBrowserUrl}\n\n${bodyText}\n\n—\nYou're receiving this because you subscribed to the Meet Me at the Fair weekend digest.\nUnsubscribe: ${args.unsubscribeUrl}\n${mailing}`;

  return { subject: args.subject, html, text };
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
