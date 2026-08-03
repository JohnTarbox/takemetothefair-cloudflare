/**
 * OPE-317 — `subscribe@meetmeatthefair.com`.
 *
 * John hands the address out at shows. Someone emails it from their phone;
 * they get the normal confirmation email and click to confirm.
 *
 * Deliberately delegates to the main app's POST /api/newsletter/subscribe
 * rather than touching newsletter_subscribers here. That endpoint already
 * handles all three cases — brand-new, existing-unconfirmed (re-issue the
 * token), existing-confirmed (no-op) — and owns the double opt-in. A second
 * implementation of consent is the last thing this system needs, and the one
 * most likely to drift into mailing someone who never agreed.
 *
 * The consent story is unchanged: emailing us is an expression of interest, NOT
 * consent to be mailed. The confirmation click is still what subscribes them,
 * exactly as it is from the web form.
 */
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";
import { logError } from "../logger.js";

const SOURCE = "mcp:email:newsletter-subscribe";

export interface NewsletterSubscribeResult {
  ok: boolean;
  status: number | null;
  detail?: string;
}

/**
 * Subscribe the SENDER of an inbound `subscribe@` email.
 *
 * `fromAddress` is the envelope sender, not anything in the body — we never
 * parse an address out of the message. Someone forwarding a friend's email must
 * not be able to sign that friend up.
 */
export async function handleNewsletterSubscribeEmail(
  env: MainAppEnv & { DB: D1Database },
  fromAddress: string
): Promise<NewsletterSubscribeResult> {
  const email = fromAddress.trim();
  if (!email || !email.includes("@")) {
    await logError(env.DB, {
      level: "warn",
      source: SOURCE,
      message: "subscribe@ email had no usable sender address; ignored",
      context: { fromAddress },
    });
    return { ok: false, status: null, detail: "no-sender" };
  }

  try {
    const res = await mainAppFetch(env, "/api/newsletter/subscribe", "fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, source: "email-subscribe" }),
    });
    await logError(env.DB, {
      level: res.ok ? "info" : "warn",
      source: SOURCE,
      message: res.ok
        ? `subscribe@ → confirmation flow started (status ${res.status})`
        : `subscribe@ → subscribe endpoint returned ${res.status}`,
      context: { email },
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    await logError(env.DB, {
      source: SOURCE,
      message: "subscribe@ → subscribe endpoint call failed",
      error: err,
      context: { email },
    });
    return { ok: false, status: null, detail: "fetch-failed" };
  }
}
