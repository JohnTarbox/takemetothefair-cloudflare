/**
 * SSRF host guard for the admin URL-import fetch route (WS3c, 2026-06-11).
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
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT 100.64.0.0/10
  );
}

/**
 * True if the host should be blocked as internal/private/unroutable. Covers:
 * internal name suffixes, loopback names, all IPv4 numeric encodings (dotted +
 * integer, decimal/hex/octal), and IPv6 loopback / link-local / ULA /
 * IPv4-mapped literals. Hostname should be lowercased URL.hostname (IPv6 keeps
 * its surrounding brackets, as URL.hostname returns them).
 */
export function isBlockedSsrfHost(hostnameRaw: string): boolean {
  const host = hostnameRaw.toLowerCase().trim();
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
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    // Loopback in any form (::1, 0:0:0:0:0:0:0:1), unspecified (::), ULA
    // (fc/fd), link-local (fe80). For loopback, ignore the "::" elision and
    // check that the only non-zero group is a trailing "1".
    const nonEmpty = inner.split(":").filter((g) => g !== "");
    const isLoopback =
      inner === "::1" ||
      (nonEmpty.length > 0 &&
        nonEmpty.every((g, i) => (i === nonEmpty.length - 1 ? /^0*1$/.test(g) : /^0+$/.test(g))));
    if (
      inner === "::" ||
      isLoopback ||
      inner.startsWith("fc") ||
      inner.startsWith("fd") ||
      inner.startsWith("fe80")
    ) {
      return true;
    }
    // IPv4-mapped / -translated (::ffff:127.0.0.1, ::ffff:7f00:1, 64:ff9b::x).
    const mapped = inner.match(/(?:::ffff:|::ffff:0:|64:ff9b::)(.+)$/);
    if (mapped) {
      const tail = mapped[1];
      const v4 = looseParseIpv4(tail);
      if (v4) return isPrivateIpv4(v4[0], v4[1]);
      // ::ffff:7f00:1 form — two hex groups encoding the v4. Be conservative:
      // any ::ffff: mapped literal that isn't a clearly-public dotted-quad → block.
      return true;
    }
    return false;
  }

  // IPv4 in any numeric encoding.
  const v4 = looseParseIpv4(host);
  if (v4) return isPrivateIpv4(v4[0], v4[1]);

  return false;
}
