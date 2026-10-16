/**
 * OPE-1378 (AUTH6) — `?callbackUrl=` is attacker-controlled.
 *
 * The credentials login (`src/app/(auth)/login/page.tsx`) passed it straight to
 * `router.push()`, so `/login?callbackUrl=https://evil.example` sent a user
 * off-site right after a real sign-in. Only a same-origin RELATIVE path is
 * accepted; anything else falls back to `/`.
 *
 * Rejected shapes, and why:
 *   - not starting with `/`            absolute URLs, `javascript:`, bare hosts
 *   - `//host`                         protocol-relative: off-site
 *   - any backslash                    browsers normalise `\` to `/`, so `/\host`
 *                                      is `//host`
 *   - control characters (incl. TAB,   the URL parser strips TAB/CR/LF, so
 *     CR, LF)                          `/\t/host` becomes `//host`
 */
export function safeCallbackUrl(raw: string | null | undefined, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}
