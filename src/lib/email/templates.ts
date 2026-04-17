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
