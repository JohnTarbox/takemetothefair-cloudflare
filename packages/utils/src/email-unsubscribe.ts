/**
 * Stateless one-click unsubscribe tokens (CAN-SPAM, K36 / 2026-06-25).
 *
 * The unsubscribe link in an outbound footer must work for ANY recipient
 * without pre-storing a per-send token row, so the token is an HMAC-SHA256 of
 * the lowercased recipient email keyed by a shared secret. The MCP Worker that
 * renders the footer and the main-app route that verifies the click both hold
 * the same `INTERNAL_API_KEY`, so that doubles as the default key — no new
 * secret to provision on two workers. Forging a token requires the secret; the
 * worst a forged token does is suppress a single address (idempotent).
 */

import { timingSafeEqualString } from "./timing-safe-equal";
import { openClaim, sealClaim } from "./unsubscribe-seal";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * URL-safe base64 (RFC 4648 §5, unpadded) of an ASCII string. Used to carry the
 * recipient email as a PATH segment in the unsubscribe URL — see
 * {@link buildUnsubscribeUrl} for why a query string can't be used.
 */
export function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of {@link base64UrlEncode}. Throws on malformed input. */
export function base64UrlDecode(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

/** HMAC-SHA256(secret, lowercased-email) as lowercase hex. */
export async function computeUnsubscribeToken(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(normalizeEmail(email)));
  return toHex(sig);
}

/** Constant-time verify of a token against the email it should authorize. */
export async function verifyUnsubscribeToken(
  secret: string,
  email: string,
  token: string
): Promise<boolean> {
  if (!secret || !email || !token) return false;
  const expected = await computeUnsubscribeToken(secret, email);
  return timingSafeEqualString(expected, token);
}

/**
 * Absolute one-click unsubscribe URL for `email`. `publicHost` is the bare
 * origin (e.g. `https://meetmeatthefair.com`). Async because the token is
 * an HMAC.
 *
 * Both values go in PATH segments (`/unsubscribe/<b64url-email>/<token>`), NOT
 * a query string. Reason (found live 2026-06-25): the outbound MIME body is
 * quoted-printable encoded by Cloudflare Email Sending, and a literal `=`
 * followed by two hex digits (`&t=2c…`) is mis-decoded as a QP escape on the
 * receiving end, corrupting the token. Every HMAC token is hex, so `?t=<token>`
 * broke on EVERY send. Path segments contain no `=`, so QP can't touch them
 * (and QP soft-wrap `=\r\n` decodes away cleanly). base64url keeps the email
 * free of `@`/`.`/`=` that could reintroduce the hazard.
 */
export async function buildUnsubscribeUrl(
  publicHost: string,
  secret: string,
  email: string
): Promise<string> {
  // OPE-864 — `/unsubscribe/v2/<sealed>`: the address is ENCRYPTED, not
  // base64'd, so the link no longer hands the recipient's email to anyone who
  // sees the URL. The legacy `/unsubscribe/<b64-email>/<hmac>` form still
  // verifies (see the route) for every link already delivered.
  const sealed = await sealClaim(secret, normalizeEmail(email));
  return `${publicHost.replace(/\/$/, "")}/unsubscribe/${SEALED_SEGMENT}/${sealed}`;
}

/** The first path segment that marks a sealed (v2) link. Never a legacy b64 email (≥ 8 chars). */
export const SEALED_SEGMENT = "v2";

/** The address inside a sealed link, or null if it is forged, truncated or not an email. */
export async function openUnsubscribeEmail(secret: string, sealed: string): Promise<string | null> {
  const claim = await openClaim(secret, sealed);
  return claim && claim.includes("@") ? claim : null;
}

/** `verify` for a sealed link: the seal must open, under this secret, to this address. */
export async function verifySealedUnsubscribe(
  secret: string,
  email: string,
  sealed: string
): Promise<boolean> {
  return (await openUnsubscribeEmail(secret, sealed)) === normalizeEmail(email);
}

// ─── OPE-1346 — which secret signs, which secrets verify ─────────────────────
//
// The key was `UNSUBSCRIBE_SECRET || INTERNAL_API_KEY`, inlined at every sign
// and verify site. With one key doing both jobs, the master cross-Worker key
// could not be rotated — not even after a leak — without breaking every link
// already sent, and CAN-SPAM requires those to keep working for 30 days. Adding
// UNSUBSCRIBE_SECRET had the same trap: it took precedence on verify too.
//
// Now signing and verifying are separate questions with separate answers:
//   SIGN   with the first present of UNSUBSCRIBE_SECRET, INTERNAL_API_KEY.
//          Never `_PREVIOUS` — a retired key must not mint new links.
//   VERIFY against every present one of UNSUBSCRIBE_SECRET, INTERNAL_API_KEY,
//          UNSUBSCRIBE_SECRET_PREVIOUS, in that order.
// So setting UNSUBSCRIBE_SECRET moves new mail onto it while old links keep
// verifying under INTERNAL_API_KEY; after 30+ days INTERNAL_API_KEY can be
// dropped from the list (docs/unsubscribe-secret-rotation.md).

/** The env keys the unsubscribe secrets live under, on both Workers. */
export interface UnsubscribeSecretEnv {
  UNSUBSCRIBE_SECRET?: string;
  INTERNAL_API_KEY?: string;
  UNSUBSCRIBE_SECRET_PREVIOUS?: string;
  /**
   * Set to "1" at runbook step (c), once every link signed under the internal
   * key is past 30 days: verify stops accepting INTERNAL_API_KEY, which is then
   * free to rotate. Ignored while UNSUBSCRIBE_SECRET is unset (it is the signer).
   */
  UNSUBSCRIBE_RETIRE_INTERNAL_KEY?: string;
}

/** The ONE secret new footer links are signed with. Empty string = none configured. */
export function unsubscribeSigningSecret(env: UnsubscribeSecretEnv | undefined | null): string {
  return env?.UNSUBSCRIBE_SECRET || env?.INTERNAL_API_KEY || "";
}

/** Every secret a delivered link may have been signed with, ordered, deduplicated, non-empty. */
export function unsubscribeVerifySecrets(env: UnsubscribeSecretEnv | undefined | null): string[] {
  const retireInternal =
    Boolean(env?.UNSUBSCRIBE_SECRET) && env?.UNSUBSCRIBE_RETIRE_INTERNAL_KEY === "1";
  const ordered = [
    env?.UNSUBSCRIBE_SECRET,
    retireInternal ? undefined : env?.INTERNAL_API_KEY,
    env?.UNSUBSCRIBE_SECRET_PREVIOUS,
  ];
  return [...new Set(ordered.filter((s): s is string => typeof s === "string" && s.length > 0))];
}

/** Legacy HMAC token: valid if it verifies under ANY accepted secret. */
export async function verifyUnsubscribeTokenAny(
  secrets: string[],
  email: string,
  token: string
): Promise<boolean> {
  for (const s of secrets) {
    if (await verifyUnsubscribeToken(s, email, token)) return true;
  }
  return false;
}

/** Sealed (v2) link: the address it opens to under the first accepted secret that opens it. */
export async function openUnsubscribeEmailAny(
  secrets: string[],
  sealed: string
): Promise<string | null> {
  for (const s of secrets) {
    const email = await openUnsubscribeEmail(s, sealed);
    if (email) return email;
  }
  return null;
}

/** Sealed (v2) link: valid if it opens to `email` under ANY accepted secret. */
export async function verifySealedUnsubscribeAny(
  secrets: string[],
  email: string,
  sealed: string
): Promise<boolean> {
  return (await openUnsubscribeEmailAny(secrets, sealed)) === normalizeEmail(email);
}
