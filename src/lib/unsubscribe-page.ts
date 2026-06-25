/**
 * Minimal HTML response for the one-click unsubscribe routes (K36). Shared by
 * the path-based route (`/unsubscribe/[e]/[t]`) and the legacy query route
 * (`/unsubscribe?e=&t=`).
 */
export function unsubscribePage(title: string, message: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#1f2937;line-height:1.6}h1{font-size:1.4rem}a{color:#b45309}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="https://meetmeatthefair.com">Return to Meet Me at the Fair</a></p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const INVALID_TITLE = "Invalid unsubscribe link";

/**
 * Shared core for both unsubscribe routes: verify the HMAC token for `email`,
 * and on success add the address to the suppression list (idempotent). Returns
 * the page Response. `db`/`suppress` are injected so this stays free of the
 * Cloudflare runtime imports (keeps it unit-testable and avoids duplicating the
 * insert in two routes).
 */
export async function handleUnsubscribe(opts: {
  email: string;
  token: string;
  secret: string;
  verify: (secret: string, email: string, token: string) => Promise<boolean>;
  suppress: (email: string) => Promise<void>;
}): Promise<Response> {
  const email = opts.email.trim().toLowerCase();
  if (!email || !opts.token) {
    return unsubscribePage(
      INVALID_TITLE,
      "This link is missing information. Please use the link from the email exactly as it appears.",
      400
    );
  }
  const valid = await opts.verify(opts.secret, email, opts.token);
  if (!valid) {
    return unsubscribePage(
      INVALID_TITLE,
      "We couldn't verify this unsubscribe link. It may be malformed — please use the link from the email exactly as it appears.",
      400
    );
  }
  await opts.suppress(email);
  return unsubscribePage(
    "You've been unsubscribed",
    "You won't receive further outreach emails from Meet Me at the Fair at this address. If this was a mistake, just reply to any prior email and we'll help.",
    200
  );
}
