// OPE-169 — one-click newsletter unsubscribe tokens. STATELESS by design: the
// token is `base64url(email) . base64url(HMAC-SHA256(email))`, so any confirmed
// subscriber can be unsubscribed immediately without a per-row token column or
// backfill. The email is embedded (the handler needs to know whom to flip) and
// signed so a token can't be forged to unsubscribe an arbitrary address.
//
// Pure functions — the signing secret is injected so they're unit-testable. The
// route/send path resolves the secret from the Worker env (see
// resolveUnsubscribeSecret). One-click, no login (CAN-SPAM requirement).

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacB64url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time string compare (avoids leaking signature length/prefix). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The signing secret for unsubscribe tokens. Reuses AUTH_SECRET (a stable
 *  server secret) unless a dedicated NEWSLETTER_UNSUBSCRIBE_SECRET is set. Kept
 *  here (not in the route file) so route modules only export handlers. */
export function resolveUnsubscribeSecret(
  env: Record<string, string | undefined>
): string | undefined {
  return env.NEWSLETTER_UNSUBSCRIBE_SECRET || env.AUTH_SECRET || env.NEXTAUTH_SECRET;
}

/**
 * OPE-864 — the separator between the email and the list inside the payload.
 *
 * `|` is not legal in an unquoted email local part, and every address we sign is
 * `.trim().toLowerCase()`d and came through a Zod `.email()` validator, so it
 * cannot appear in the address half. If that ever stops being true, the split
 * below takes everything BEFORE the last separator as the email, which
 * degrades to "unrecognised list" rather than to a wrong address.
 */
const LIST_SEP = "|";

export interface UnsubscribeTokenClaims {
  /** Normalized (trimmed, lowercased) address. */
  email: string;
  /**
   * Which list this token unsubscribes from, or `null` for a LEGACY token.
   *
   * ⚠️ `null` means "every list", and that is deliberate. Tokens signed before
   * OPE-864 are sitting in people's inboxes with no list component, and they
   * were sent under a promise that clicking them stops all our mail. Narrowing
   * a legacy token to one list would leave someone subscribed who believes they
   * unsubscribed — a strictly worse failure than the one being fixed.
   */
  list: string | null;
}

/**
 * Sign a one-click unsubscribe token for `email`, optionally scoped to `list`.
 *
 * The list travels INSIDE the signed payload rather than as a separate URL
 * parameter, so it cannot be edited in transit. An attacker who could change
 * `?list=vendor` to `?list=weekend` on someone else's link could unsubscribe
 * them from a list they never asked to leave.
 */
export async function signUnsubscribeToken(
  email: string,
  secret: string,
  list?: string | null
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const claim = list ? `${normalized}${LIST_SEP}${list}` : normalized;
  const payload = b64urlEncode(new TextEncoder().encode(claim));
  const sig = await hmacB64url(secret, payload);
  return `${payload}.${sig}`;
}

/**
 * Verify a token; returns the claims if valid, else null.
 *
 * Legacy tokens (no separator in the payload) verify exactly as before and
 * report `list: null`. That path is not incidental — it is tested, because it
 * is what every link already delivered depends on.
 */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string
): Promise<UnsubscribeTokenClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacB64url(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const claim = b64urlDecodeToString(payload);
    const sep = claim.lastIndexOf(LIST_SEP);
    const email = sep === -1 ? claim : claim.slice(0, sep);
    const list = sep === -1 ? null : claim.slice(sep + 1);
    if (!email.includes("@")) return null;
    return { email, list: list || null };
  } catch {
    return null;
  }
}
