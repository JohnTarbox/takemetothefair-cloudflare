/**
 * Constant-time string equality for secret comparison.
 *
 * Used wherever the server verifies an incoming credential against an
 * expected secret — `INTERNAL_API_KEY` (cross-Worker contract) and the
 * `CLAUDE_READONLY_TOKEN` Bearer. A naive `a === b` short-circuits on the
 * first differing byte, so its runtime leaks how many leading bytes matched;
 * an attacker who can measure response timing could in principle recover a
 * secret byte-by-byte. These secrets are high-entropy env values so the
 * practical risk is low, but constant-time comparison is the correct,
 * cheap default.
 *
 * Implementation notes — why hash-then-compare rather than a raw byte loop:
 *  - We SHA-256 both inputs first. That makes both operands a fixed 32 bytes
 *    regardless of input length, so the comparison time does not depend on
 *    (and cannot leak) the secret's length, and there is no need to branch on
 *    a length mismatch.
 *  - We deliberately do NOT use `crypto.subtle.timingSafeEqual` — that is a
 *    Cloudflare-Workers-only extension (it is `undefined` under Node/vitest,
 *    so tests would break). `crypto.subtle.digest` is standard Web Crypto and
 *    is present in the Workers runtime, the next-on-pages edge runtime, AND
 *    Node 18+ — so this one helper is portable across all three.
 *  - The final XOR-accumulate loop runs over the two 32-byte digests with no
 *    early exit, so it is constant-time with respect to digest contents.
 *
 * This is the one async, non-pure-arithmetic export in this package; it stays
 * here (not in app code) precisely so the main app and the MCP Worker — two
 * separate deploy artifacts — share a single audited implementation.
 */
export async function timingSafeEqualString(
  a: string | undefined | null,
  b: string | undefined | null
): Promise<boolean> {
  // A missing expected secret or missing presented value never authorizes.
  // Returning early here is safe: it leaks only "one side was absent", not
  // any bytes of a present secret.
  if (!a || !b) return false;

  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);

  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i] ^ vb[i];
  }
  return diff === 0;
}
