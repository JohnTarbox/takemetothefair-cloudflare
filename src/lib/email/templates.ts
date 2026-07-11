/**
 * Minimal transactional email templates. Inline styles so they render in all
 * clients. Kept small deliberately — real brand templates can come later when
 * we decide on a template library (React Email, MJML, etc.).
 */

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
}): { subject: string; html: string; text: string } {
  const mailing = args.mailingAddress?.trim() || "Meet Me at the Fair, New England";
  const viewLine = `<div style="text-align:center;font-size:12px;color:#8A8178;margin:0 0 16px;"><a href="${args.viewInBrowserUrl}" style="color:#1E2761;">View this email in your browser</a></div>`;
  const unsubFooter = `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #E5DFD6;font-size:12px;line-height:1.5;color:#8A8178;">You're receiving this because you subscribed to the Meet Me at the Fair weekend digest.<br><a href="${args.unsubscribeUrl}" style="color:#8A8178;text-decoration:underline;">Unsubscribe</a><br>${escapeHtmlText(mailing)}</div>`;
  const html = baseLayout({
    heading: args.subject,
    body: `${viewLine}${args.contentHtml}${unsubFooter}`,
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
