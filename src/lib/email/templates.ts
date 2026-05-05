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
