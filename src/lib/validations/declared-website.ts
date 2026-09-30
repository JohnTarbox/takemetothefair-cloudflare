/**
 * OPE-1155 — the ONE rule for a self-declared website, shared by the register
 * form and /api/auth/register.
 *
 * They used to disagree. The form accepted anything matching
 * `/^https?:\/\/.+\..+/`; the server required `z.string().url()`, i.e. that
 * `new URL()` parses it. A value in the gap — a space inside the host, two
 * addresses pasted into one box, an out-of-range port — passed the form and
 * was refused by the server, which blocked the whole ACCOUNT over an optional
 * field. A real vendor hit it twice on 2026-09-24.
 *
 * Returns the normalised href, or null when there is no usable address.
 * A missing scheme gets `https://` so "www.example.com" is accepted rather
 * than bounced. Pure — no host policy here; the server layers its SSRF
 * refusal on top, because that check is not safe to ship to the browser.
 */
export function normalizeDeclaredWebsite(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Longer than any real site address; dropped, not stored.
  if (trimmed.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A dotted hostname — the same bar the form's old regex set, so "https://foo"
  // is still refused.
  if (!url.hostname.includes(".")) return null;
  return url.href;
}
