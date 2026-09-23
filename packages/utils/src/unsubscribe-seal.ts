/**
 * OPE-864 — an unsubscribe link must not carry a readable email address.
 *
 * Both unsubscribe token formats embedded the recipient as plain base64:
 *
 *   Path A  /api/newsletter/unsubscribe?token=<b64(email|list)>.<hmac>
 *   Path B  /unsubscribe/<b64(email)>/<hmac>
 *
 * `echo am9obkBwaW1ib2F0LmNvbXx3ZWVrZW5k | base64 -d` → `john@pimboat.com|weekend`.
 * Anyone the mail is forwarded to, any link-scanner log, any referrer, reads
 * the subscriber's address straight out of the URL.
 *
 * The fix keeps both formats STATELESS (their stated design — no per-send token
 * row) by encrypting the claim instead of merely signing it: AES-GCM with a key
 * derived from the same secret the HMAC used. GCM's tag authenticates the
 * ciphertext, so a sealed claim is unforgeable exactly as the HMAC made it —
 * and additionally unreadable.
 *
 * Output is base64url, unpadded: no `=`, so it survives the quoted-printable
 * encoding that corrupted hex tokens in K36.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Domain-separated so this key can never collide with the HMAC use of the same secret. */
const KEY_CONTEXT = "mmatf-unsubscribe-seal-v1";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sealKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${KEY_CONTEXT}:${secret}`)
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt-and-authenticate `claim`. Random IV, so two seals of one claim differ. */
export async function sealClaim(secret: string, claim: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await sealKey(secret),
      encoder.encode(claim)
    )
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64url(out);
}

/** The claim, or null if the seal was tampered with, truncated, or made with another secret. */
export async function openClaim(secret: string, sealed: string): Promise<string | null> {
  if (!secret || !sealed) return null;
  try {
    const bytes = unb64url(sealed);
    if (bytes.length <= 12 + 16) return null; // IV + GCM tag, no payload
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await sealKey(secret),
      bytes.slice(12)
    );
    return decoder.decode(pt);
  } catch {
    return null;
  }
}
