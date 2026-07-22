// OPE-231 — one-tap "Approve & send to everyone" tokens for the Weekend Fair
// Digest preview email.
//
// This token authorises a LIVE CUSTOMER BROADCAST from a link in John's inbox,
// so it is deliberately stronger than the stateless unsubscribe token
// (newsletter-unsubscribe-token.ts): it binds to a single issue slug AND
// carries a signed expiry, so a leaked or forwarded preview can't be used to
// fire a broadcast weeks later.
//
// Three properties the ticket requires, and where each lives:
//   - SIGNED / unguessable ...... HMAC-SHA256 over the payload (here)
//   - TTL-bounded ............... `exp` epoch-ms inside the signed payload (here)
//   - SINGLE-USE ................ the `newsletter_issues.sent_at` latch in the
//                                 approve route — a token cannot be "spent" in a
//                                 stateless string, so single-use is enforced at
//                                 the broadcast, not here. See approve/route.ts.
//
// Pure functions; the signing secret is injected so they're unit-testable.

/** Domain separator so an approve token can never be cross-read as some other
 *  HMAC token that happens to share the secret (AUTH_SECRET is shared). The
 *  unsubscribe token signs a bare payload; prefixing the message here means the
 *  two signing schemes occupy disjoint spaces even under the same key. */
const APPROVE_DOMAIN = "newsletter-approve:v1";

/** How long a preview's approval link stays usable. The ticket asks for ~72h —
 *  long enough for a weekend digest previewed Friday to be approved through the
 *  weekend, short enough that a stale preview can't fire much later. */
export const APPROVE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

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

/** Constant-time compare (avoids leaking signature length/prefix). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signing secret for approve tokens. Reuses AUTH_SECRET (a stable server
 *  secret) unless a dedicated NEWSLETTER_APPROVE_SECRET is set. Kept here (not
 *  in a route file) so route modules only export handlers. */
export function resolveApproveSecret(env: Record<string, string | undefined>): string | undefined {
  return env.NEWSLETTER_APPROVE_SECRET || env.AUTH_SECRET || env.NEXTAUTH_SECRET;
}

export interface ApproveTokenClaims {
  slug: string;
  /** Expiry, epoch-ms. */
  exp: number;
}

/**
 * Mint an approval token for one issue slug, expiring `ttlMs` from `now`.
 * The expiry is INSIDE the signed payload, so it cannot be extended by an
 * attacker without invalidating the signature.
 */
export async function signApproveToken(
  slug: string,
  secret: string,
  now: Date = new Date(),
  ttlMs: number = APPROVE_TOKEN_TTL_MS
): Promise<string> {
  const claims: ApproveTokenClaims = { slug, exp: now.getTime() + ttlMs };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await hmacB64url(secret, `${APPROVE_DOMAIN}.${payload}`);
  return `${payload}.${sig}`;
}

/**
 * Verify an approval token. Returns its claims when the signature is valid AND
 * the token has not expired; null on a bad/forged signature, a malformed token,
 * or expiry. Never throws — a public route feeds it untrusted query input.
 */
export async function verifyApproveToken(
  token: string,
  secret: string,
  now: Date = new Date()
): Promise<ApproveTokenClaims | null> {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacB64url(secret, `${APPROVE_DOMAIN}.${payload}`);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(b64urlDecodeToString(payload)) as unknown;
    if (
      typeof claims !== "object" ||
      claims === null ||
      typeof (claims as ApproveTokenClaims).slug !== "string" ||
      typeof (claims as ApproveTokenClaims).exp !== "number"
    ) {
      return null;
    }
    const c = claims as ApproveTokenClaims;
    if (!c.slug || c.exp <= now.getTime()) return null; // expired or empty slug
    return c;
  } catch {
    return null;
  }
}
