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
