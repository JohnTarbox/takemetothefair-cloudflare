# SSRF guard + inbound-email trust boundary (WS3c / WS3e, 2026-06-11)

## WS3c — SSRF guard on `/api/admin/import-url/fetch`

**Threat model (why this is defense-in-depth, not critical):** the only caller
is the **ADMIN-gated** URL-import fetch route, running on **Cloudflare Workers**.
Workers have no cloud-metadata endpoint (`169.254.169.254` is an EC2/GCE-VM
concern), no internal HTTP network (D1/KV/R2 are bindings, not URLs), and CF's
`fetch()` refuses many private ranges at the platform layer. So an SSRF here has
near-zero blast radius — but the control should be correct on its own terms.

**Before:** an inline string check blocked `localhost`, `[::1]`, `.local`,
`.internal`, dotted-decimal private IPv4, and `fc/fd/fe80` IPv6. It **missed**:

| Bypass | Example | Now |
| --- | --- | --- |
| decimal-integer IP | `http://2130706433/` → 127.0.0.1 | blocked |
| hex IP | `http://0x7f000001/` | blocked |
| octal-dotted IP | `http://0177.0.0.1/` | blocked |
| IPv4-mapped IPv6 | `http://[::ffff:127.0.0.1]/` | blocked |
| expanded loopback | `http://[0:0:0:0:0:0:0:1]/` | blocked |
| CGNAT range | `100.64.0.0/10` | blocked |

**After:** `src/lib/url-import/ssrf-guard.ts` — `isBlockedSsrfHost(hostname)`,
a pure, unit-tested helper (`__tests__/ssrf-guard.test.ts`, 38 cases) that
normalizes all IPv4 numeric encodings (inet_aton-style) and handles IPv6
loopback/ULA/link-local/mapped literals. Wired into the route.

**Residual (documented, NOT fixed): DNS rebinding** — a public hostname that
*resolves* to an internal IP passes any string check. Closing it needs IP
resolution + re-check, which the Workers `fetch` runtime doesn't expose.
Accepted given the threat model above.

## WS3e — inbound-email sender-trust boundary

**The boundary:** inbound mail (Cloudflare Email Routing → MCP Worker
`email-handler.ts`) classifies a sender into a trust tier via
`lookupSenderTrust(from)`. A **`trusted`** sender takes a **fast-path** that
*skips the spam/intent AI classifier* and routes on the address-based intent.

**The gap:** the trust tier was keyed purely on the **From address, which is
spoofable**. Nothing read SPF/DKIM/DMARC. A spoofed From of a trusted sender
whose domain lacks a strict DMARC policy (so CF forwards rather than rejects)
would get the reduced-scrutiny fast-path.

**Mitigation already in place:** Cloudflare Email Routing applies SPF/DKIM/DMARC
at the routing layer and rejects mail that fails a domain's `p=reject`/
`quarantine` DMARC policy before it reaches the Worker. So spoofing a trusted
sender whose domain publishes strict DMARC is already blocked upstream. The gap
is trusted senders on `p=none`/no-DMARC domains.

**What WS3e adds (`src/email-auth.ts` + handler):** parse the
`Authentication-Results` header CF attaches → `pass | fail | unknown`
(`parseEmailAuth`, 9 unit tests). The trusted fast-path is now gated on
`emailAuth !== "fail"`:
- **`fail`** (DMARC fail, or SPF hard-fail with no DKIM pass) → fast-path
  **downgraded**; the message falls through to the full classifier. A `warn`
  row is logged (`email-handler:ws3e-auth-gate`).
- **`unknown`** (header absent / `none` / `softfail`) → **fail-open**: the
  fast-path still applies (so existing trusted senders aren't broken if CF's
  header is absent or formatted unexpectedly), but an `info` row is logged.
- **`pass`** → honored as before, silently.

**Deliberately conservative.** Fail-open on `unknown` means this only *adds*
protection (on proven spoofs) and never breaks the happy path. The `info`/`warn`
logs exist so prod can confirm how reliably CF attaches `Authentication-Results`
and how often trusted mail is `unknown`. **Follow-up (once that signal is in):**
tighten the gate to require `emailAuth === "pass"` for the trusted fast-path.

**Not changed:** the non-fast-path flow (full classifier) is unaffected — auth
state only influences whether the *trust shortcut* applies; every message still
runs through dedup, gates, and (for non-trusted/`fail`) the spam classifier.
