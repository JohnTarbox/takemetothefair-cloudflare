/**
 * SSRF host guard (WS3c, 2026-06-11). Since OPE-1370 it is applied to every
 * redirect hop by `guardedFetch` (guarded-fetch.ts), which is how outbound
 * fetches of user/email/page-supplied URLs should call it; the paragraph below
 * describes its original single caller and still holds as the threat model.
 *
 * THREAT MODEL / why this is defense-in-depth, not a critical control:
 *   - The only caller is the ADMIN-gated /api/admin/import-url/fetch route
 *     (admins are trusted), and it runs on Cloudflare Workers. Workers have no
 *     cloud-metadata endpoint (169.254.169.254 is an EC2/GCE-VM concern, not a
 *     Workers one), no internal HTTP network (D1/KV/R2 are bindings, not URLs),
 *     and CF's fetch() refuses many private ranges at the platform layer. So
 *     the blast radius of an SSRF here is near-zero regardless.
 *   - We still block the obvious + encoded internal targets so the control is
 *     correct on its own terms and portable if this ever moves off Workers.
 *
 * RESIDUAL (documented, not fixed): DNS rebinding — a public hostname that
 * RESOLVES to an internal IP — passes any string check. Closing it requires
 * resolving the host to an IP and re-checking, which the Workers fetch runtime
 * does not expose. Accepted given the threat model above.
 */

/** Parse one IPv4 octet in decimal / 0x-hex / leading-zero-octal form. */
function parseOctet(part: string): number | null {
  if (part === "") return null;
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part, 16);
  else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
  else if (/^\d+$/.test(part)) n = parseInt(part, 10);
  else return null;
  return Number.isFinite(n) ? n : null;
}

/**
 * Interpret a hostname as an IPv4 address in any of the forms a fetch/DNS stack
 * accepts — dotted (decimal/octal/hex octets), or a bare 32-bit integer
 * (decimal/hex/octal) — and return the four octets, or null if it is not a
 * numeric host. Mirrors inet_aton's permissive parsing, which is exactly what
 * makes `http://2130706433/` and `http://0x7f.1/` reach 127.0.0.1.
 */
function looseParseIpv4(host: string): [number, number, number, number] | null {
  // Bare integer forms (no dots): 2130706433, 0x7f000001, 017700000001.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    const n = /^0x/i.test(host)
      ? parseInt(host, 16)
      : /^0[0-7]+$/.test(host)
        ? parseInt(host, 8)
        : parseInt(host, 10);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  // Dotted forms. Only treat as an IP candidate if every label is numeric —
  // otherwise it's a normal DNS name (e.g. "1.example.com" has a non-numeric
  // label and is left to normal resolution).
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) return null;
  const octets = parts.map(parseOctet);
  if (octets.some((o) => o === null || o! < 0 || o! > 255)) return null;
  return octets as [number, number, number, number];
}

function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // private 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // private 172.16.0.0/12
    (a === 192 && b === 168) || // private 192.168.0.0/16
    (a === 169 && b === 254) || // link-local + cloud metadata 169.254.0.0/16
    a === 0 || // 0.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT 100.64.0.0/10
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  );
}

/**
 * OPE-1370 — parse an IPv6 literal (no brackets) into its eight 16-bit
 * groups, accepting "::" elision and an embedded dotted-IPv4 tail. Returns
 * null for anything malformed (including a zone id).
 */
function parseIpv6(addr: string): number[] | null {
  if (addr.includes("%")) return null;
  let text = addr;
  const lastColon = text.lastIndexOf(":");
  const v4Tail = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (v4Tail.includes(".")) {
    const o = v4Tail.split(".");
    if (o.length !== 4 || !o.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    const n = o.map(Number);
    text =
      text.slice(0, lastColon + 1) +
      ((n[0] << 8) | n[1]).toString(16) +
      ":" +
      ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1]);
  if (!rest) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

/** First two octets of the IPv4 held in 16-bit group `i` (and `i + 1`). */
function v4Prefix(g: number[], i: number): [number, number] {
  return [g[i] >> 8, g[i] & 0xff];
}

/**
 * True for an IPv6 address that is internal, or that embeds an internal IPv4.
 * An unparseable literal is BLOCKED: one we cannot read is one we cannot vouch for.
 */
function isBlockedIpv6(inner: string): boolean {
  const g = parseIpv6(inner);
  if (!g) return true;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::/96 — unspecified (::), loopback (::1) and the deprecated
  // IPv4-COMPATIBLE form ::a.b.c.d, which URL normalizes to e.g. [::7f00:1].
  // OPE-1370: the previous string check let [::7f00:1] through.
  if (zero(0, 6)) return true;
  // ::ffff:0:0/96 IPv4-mapped, ::ffff:0:0:0/96 IPv4-translated.
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateIpv4(...v4Prefix(g, 6));
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateIpv4(...v4Prefix(g, 6));
  // 64:ff9b::/96 NAT64 well-known prefix; 64:ff9b:1::/48 local-use NAT64.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true;
    if (zero(2, 6)) return isPrivateIpv4(...v4Prefix(g, 6));
  }
  // 2002::/16 6to4 — the IPv4 sits in groups 1–2.
  if (g[0] === 0x2002) return isPrivateIpv4(...v4Prefix(g, 1));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/**
 * True if the host should be blocked as internal/private/unroutable. Covers:
 * internal name suffixes, loopback names (with or without the DNS root's
 * trailing dot), all IPv4 numeric encodings (dotted + integer,
 * decimal/hex/octal), and IPv6 unspecified / loopback / IPv4-compatible /
 * IPv4-mapped / NAT64 / 6to4 / ULA / link-local / multicast literals.
 * Hostname should be URL.hostname (IPv6 keeps its surrounding brackets, as
 * URL.hostname returns them).
 */
export function isBlockedSsrfHost(hostnameRaw: string): boolean {
  // OPE-1370 — `localhost.` is the same name as `localhost` (the trailing dot
  // is the DNS root) and URL.hostname keeps it, so every suffix check below
  // missed it. Strip ALL trailing dots before comparing.
  const host = hostnameRaw.toLowerCase().trim().replace(/\.+$/, "");
  if (!host) return true;

  // Internal / loopback names.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    return true;
  }

  // IPv6 literal (URL.hostname wraps these in []).
  if (host.startsWith("[") && host.endsWith("]")) return isBlockedIpv6(host.slice(1, -1));
  // A bare IPv6 literal is not what URL.hostname returns, but a caller passing
  // one should get the same answer, not a pass.
  if (host.includes(":")) return isBlockedIpv6(host);

  // IPv4 in any numeric encoding.
  const v4 = looseParseIpv4(host);
  if (v4) return isPrivateIpv4(v4[0], v4[1]);

  return false;
}
