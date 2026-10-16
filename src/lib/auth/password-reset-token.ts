/**
 * OPE-1378 (AUTH8) — password-reset tokens are stored as SHA-256(token).
 *
 * The raw token only ever exists in the emailed link. `password_reset_tokens.token`
 * holds the hex digest, the same treatment claim and API tokens already get, so
 * a read of the table (backup, log, SQL console) no longer yields a working
 * reset link. Lookup is by digest equality on the primary key, so the stored
 * value is never compared byte-by-byte against attacker input.
 */
export async function hashResetToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
