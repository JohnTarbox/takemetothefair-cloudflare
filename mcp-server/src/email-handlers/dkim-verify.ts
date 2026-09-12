/**
 * OPE-944 — DKIM verification (RFC 6376) for a message we hold the RAW BYTES of.
 *
 * WHY THIS EXISTS. Cloudflare Email Routing attaches an `Authentication-Results`
 * header describing the message it delivered to us. When a contributor forwards
 * an organizer's mail, that header describes the CONTRIBUTOR's hop and nothing
 * else — `dkim=pass header.d=gmail.com` proves Carolyn's Gmail sent it, not that
 * the Town of New Gloucester wrote it. The organizer's own signature travels
 * inside the forwarded message, and only a "Forward as attachment" preserves it
 * intact. Verifying it is the only way to tell a genuine organizer packet from
 * one somebody typed.
 *
 * WHY IT IS HAND-ROLLED. Node-oriented mail-auth libraries assume `crypto`,
 * `dns`, and Buffer streams; none of that exists on workerd. Everything here is
 * WebCrypto + fetch, which both run natively on the Workers runtime. It is
 * deliberately a VERIFIER ONLY — no signing, no policy, no caching layer.
 *
 * ⚠️ REPORT-ONLY BY CONSTRUCTION (OPE-944 STOP gate). This module returns a
 * verdict and nothing else. It must not be wired to routing, sender trust,
 * auto-publication or any outbound reply without issue-level approval — those
 * decisions are open on OPE-765 and OPE-839.
 *
 * SCOPE OF WHAT IS VERIFIED. A `verified` verdict means: the signature in the
 * DKIM-Signature header validates against the key published at
 * `<selector>._domainkey.<domain>`, AND the body hash matches, so the signed
 * headers and the covered body are byte-identical to what the signing domain
 * sent. It does NOT by itself mean the message is from who the `From:` header
 * claims — that is what `alignedWithFrom` reports, and the two are kept
 * separate on purpose.
 */

/** Why a message did not come back `verified`. Each is a DIFFERENT fact. */
export type DkimVerdict =
  /** Signature validated and the body hash matched. */
  | "verified"
  /** A signature was present and did NOT validate. Tampering, or a rewriting relay. */
  | "failed"
  /** No DKIM-Signature header at all. Not a failure — many senders do not sign. */
  | "no_signature"
  /**
   * A signature was present but the public key could not be read: DNS did not
   * answer, the selector is gone, or the record is malformed.
   *
   * Kept distinct from `failed` deliberately. Selectors are rotated and retired
   * routinely, so an OLD but perfectly genuine forward loses its key long
   * before it loses its authenticity. Collapsing the two would report honest
   * mail as forgery, which is the more expensive error here.
   */
  | "key_unavailable";

export interface DkimResult {
  verdict: DkimVerdict;
  /** The signing domain (`d=`), lowercased. */
  domain: string | null;
  /** The selector (`s=`). */
  selector: string | null;
  /** The address in the signed message's own `From:` header. */
  fromAddress: string | null;
  /**
   * Whether `d=` aligns with the `From:` domain (DMARC-style relaxed
   * alignment: equal, or one is an organizational parent of the other).
   *
   * A valid signature from a domain that is NOT the From domain is exactly what
   * a mailing list or an ESP produces. It is real, and it is not the organizer
   * vouching for the content, so it is reported separately rather than folded
   * into the verdict.
   */
  alignedWithFrom: boolean;
  /** Human-readable reason, for the audit trail. Never used for control flow. */
  detail: string;
}

/** TXT lookup, injected so tests never touch the network. */
export type TxtResolver = (name: string) => Promise<string[]>;

const CRLF = "\r\n";

/**
 * DNS-over-HTTPS against Cloudflare's own resolver.
 *
 * `1.1.1.1` rather than a public DoH aggregator because the Worker is already
 * inside Cloudflare's network, so this is a local hop.
 */
export function createDohResolver(endpoint = "https://cloudflare-dns.com/dns-query"): TxtResolver {
  return async (name: string): Promise<string[]> => {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=TXT`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) throw new Error(`DoH ${res.status}`);
    const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (body.Answer ?? [])
      .filter((a) => a.type === 16)
      .map((a) =>
        // A TXT record longer than 255 bytes arrives as several quoted strings
        // that must be CONCATENATED, not joined with a separator. A 2048-bit
        // RSA key is ~400 bytes, so every real key hits this — dropping it
        // would make long keys look malformed and short ones work.
        a.data.split(/"\s*"/).join("").replace(/^"|"$/g, "")
      );
  };
}

/** Split a raw RFC 5322 message into its header block and its body. */
export function splitMessage(raw: string): { headerBlock: string; body: string } {
  // Tolerate bare-LF messages, which some clients and most test fixtures use.
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx < 0) return { headerBlock: raw, body: "" };
  const sepLen = /\r\n\r\n/.test(raw.slice(idx, idx + 4)) ? 4 : 2;
  return { headerBlock: raw.slice(0, idx), body: raw.slice(idx + sepLen) };
}

/** Unfold a header block into `[name, rawLine]` pairs, in file order. */
export function parseHeaderLines(headerBlock: string): Array<{ name: string; line: string }> {
  const out: Array<{ name: string; line: string }> = [];
  // A continuation line starts with WSP and belongs to the header above it.
  for (const chunk of headerBlock.split(/\r?\n(?![ \t])/)) {
    if (!chunk.trim()) continue;
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    out.push({ name: chunk.slice(0, colon).trim().toLowerCase(), line: chunk });
  }
  return out;
}

/** Parse `k=v; k2=v2` DKIM tag syntax. */
export function parseTagList(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/** RFC 6376 §3.4.1 / §3.4.2 — header canonicalization. */
export function canonicalizeHeader(line: string, mode: "simple" | "relaxed"): string {
  if (mode === "simple") return line.replace(/\r?\n/g, CRLF);
  const colon = line.indexOf(":");
  const name = line.slice(0, colon).trim().toLowerCase();
  const value = line
    .slice(colon + 1)
    .replace(/\r?\n/g, "") // unfold
    .replace(/[ \t]+/g, " ") // collapse WSP runs
    .trim();
  return `${name}:${value}`;
}

/** RFC 6376 §3.4.3 / §3.4.4 — body canonicalization. */
export function canonicalizeBody(body: string, mode: "simple" | "relaxed"): string {
  let b = body.replace(/\r?\n/g, CRLF);
  if (mode === "relaxed") {
    b = b
      .split(CRLF)
      .map((l) => l.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
      .join(CRLF);
  }
  // Both modes: remove all trailing empty lines, then end with exactly one CRLF.
  b = b.replace(/(?:\r\n)*$/, "");
  // "simple" with an empty body is a single CRLF; "relaxed" with an empty body
  // is the empty string. This asymmetry is in the RFC and is load-bearing —
  // getting it wrong makes every empty-bodied message fail its body hash.
  if (b.length === 0) return mode === "simple" ? CRLF : "";
  return b + CRLF;
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The address inside a `From:` header value. */
export function extractAddress(headerValue: string): string | null {
  const angled = headerValue.match(/<([^>]+)>/);
  const raw = angled ? angled[1] : headerValue;
  const m = raw.match(/[^\s<>@,;:"]+@[^\s<>@,;:"]+/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * DMARC-style relaxed alignment: equal, or one is a subdomain of the other.
 *
 * Deliberately NOT a public-suffix-aware organizational-domain match. Without a
 * PSL this cannot tell `a.co.uk` from `co.uk`, and inventing an approximation
 * would report a number that looks authoritative and is not. Relaxed-subdomain
 * is exactly what can be computed correctly from the two strings alone.
 */
export function domainsAlign(signing: string | null, from: string | null): boolean {
  if (!signing || !from) return false;
  const s = signing.toLowerCase().replace(/\.$/, "");
  const f = from.toLowerCase().replace(/\.$/, "");
  return s === f || f.endsWith(`.${s}`) || s.endsWith(`.${f}`);
}

async function importVerifyKey(
  p: string,
  keyType: string
): Promise<{ key: CryptoKey; algo: { name: string } }> {
  const spki = fromBase64(p);
  // `as BufferSource` — workerd's lib.dom typings want a BufferSource and a
  // Uint8Array<ArrayBufferLike> does not narrow to it automatically.
  if (keyType === "ed25519") {
    const key = await crypto.subtle.importKey(
      "spki",
      spki as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return { key, algo: { name: "Ed25519" } };
  }
  const key = await crypto.subtle.importKey(
    "spki",
    spki as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return { key, algo: { name: "RSASSA-PKCS1-v1_5" } };
}

/**
 * Verify the first DKIM-Signature on a raw message.
 *
 * `raw` must be the message EXACTLY as received — any re-encoding (line-ending
 * normalisation, header reordering, MIME re-serialisation) invalidates the
 * signature, which is why the .eml is stored unmodified rather than round-
 * tripped through a parser.
 */
export async function verifyDkim(raw: string, resolveTxt: TxtResolver): Promise<DkimResult> {
  const { headerBlock, body } = splitMessage(raw);
  const headers = parseHeaderLines(headerBlock);

  const fromHeader = headers.find((h) => h.name === "from");
  const fromAddress = fromHeader
    ? extractAddress(fromHeader.line.slice(fromHeader.line.indexOf(":") + 1))
    : null;
  const fromDomain = fromAddress ? (fromAddress.split("@")[1] ?? null) : null;

  const base: DkimResult = {
    verdict: "no_signature",
    domain: null,
    selector: null,
    fromAddress,
    alignedWithFrom: false,
    detail: "no DKIM-Signature header",
  };

  const sigHeader = headers.find((h) => h.name === "dkim-signature");
  if (!sigHeader) return base;

  const sigValue = sigHeader.line.slice(sigHeader.line.indexOf(":") + 1);
  const tags = parseTagList(sigValue.replace(/\r?\n/g, ""));
  const domain = (tags.d ?? "").toLowerCase() || null;
  const selector = tags.s ?? null;
  const aligned = domainsAlign(domain, fromDomain);

  const fail = (detail: string, verdict: DkimVerdict = "failed"): DkimResult => ({
    verdict,
    domain,
    selector,
    fromAddress,
    alignedWithFrom: aligned,
    detail,
  });

  if (!domain || !selector || !tags.b || !tags.bh) return fail("malformed DKIM-Signature tag list");

  const algo = (tags.a ?? "rsa-sha256").toLowerCase();
  if (!algo.endsWith("-sha256")) return fail(`unsupported algorithm ${algo}`);
  const keyType = algo.startsWith("ed25519") ? "ed25519" : "rsa";

  const [headerCanon, bodyCanon] = (tags.c ?? "simple/simple").split("/");
  const hMode = headerCanon === "relaxed" ? "relaxed" : "simple";
  const bMode = (bodyCanon ?? headerCanon) === "relaxed" ? "relaxed" : "simple";

  // ── 1. Body hash. Checked FIRST because it needs no network. ──────────────
  let canonBody = canonicalizeBody(body, bMode);
  if (tags.l) {
    const len = Number.parseInt(tags.l, 10);
    if (Number.isFinite(len)) canonBody = canonBody.slice(0, len);
  }
  const bodyHash = toBase64(
    await crypto.subtle.digest("SHA-256", bytes(canonBody) as BufferSource)
  );
  if (bodyHash !== tags.bh.replace(/\s+/g, "")) {
    return fail("body hash mismatch — the signed body was altered in transit");
  }

  // ── 2. Rebuild the signed header block. ──────────────────────────────────
  //
  // h= lists header names in signing order. For each, take the LAST unconsumed
  // occurrence reading BOTTOM-UP (RFC 6376 §5.4.2) — that is what lets a relay
  // prepend a second `Received:` without breaking the signature.
  const consumed = new Set<number>();
  const signedNames = (tags.h ?? "").split(":").map((n) => n.trim().toLowerCase());
  const parts: string[] = [];
  for (const name of signedNames) {
    if (!name) continue;
    let picked = -1;
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i].name === name && !consumed.has(i)) {
        picked = i;
        break;
      }
    }
    // A name in h= with no matching header is signed as the empty string —
    // that is how a signer commits to a header being ABSENT.
    if (picked < 0) continue;
    consumed.add(picked);
    parts.push(canonicalizeHeader(headers[picked].line, hMode));
  }

  // The DKIM-Signature header itself is signed last, with the b= VALUE emptied
  // (the tag stays) and with NO trailing CRLF.
  const sigForSigning = sigHeader.line.replace(/(;?\s*\bb=)[^;]*/, "$1");
  parts.push(canonicalizeHeader(sigForSigning, hMode));
  const signedData = parts.join(CRLF);

  // ── 3. Public key. ───────────────────────────────────────────────────────
  const dnsName = `${selector}._domainkey.${domain}`;
  let records: string[];
  try {
    records = await resolveTxt(dnsName);
  } catch (err) {
    return fail(`DNS lookup failed for ${dnsName}: ${String(err)}`, "key_unavailable");
  }
  if (records.length === 0) return fail(`no TXT record at ${dnsName}`, "key_unavailable");

  const keyRecord = records.map((r) => parseTagList(r)).find((r) => r.p !== undefined);
  if (!keyRecord || keyRecord.p === undefined) {
    return fail(`no p= tag in the key record at ${dnsName}`, "key_unavailable");
  }
  // ⚠️ ORDER MATTERS, and getting it wrong costs the distinction this verdict
  // exists to make. An empty `p=` is the RFC's way of saying the key was
  // REVOKED — a definite statement BY the domain, so it is `failed`, not a
  // lookup problem. Testing `!keyRecord.p` above would swallow "" as falsy and
  // report `key_unavailable`, leaving this branch unreachable. That is exactly
  // what the first version of this function did, and the unit test below is
  // what found it.
  if (keyRecord.p === "") return fail(`key revoked (empty p=) at ${dnsName}`);

  let verified: boolean;
  try {
    const { key, algo: verifyAlgo } = await importVerifyKey(keyRecord.p, keyRecord.k ?? keyType);
    verified = await crypto.subtle.verify(
      verifyAlgo,
      key,
      fromBase64(tags.b) as BufferSource,
      bytes(signedData) as BufferSource
    );
  } catch (err) {
    return fail(`key import or verify threw: ${String(err)}`, "key_unavailable");
  }

  return verified
    ? {
        verdict: "verified",
        domain,
        selector,
        fromAddress,
        alignedWithFrom: aligned,
        detail: `signature valid for d=${domain} s=${selector}`,
      }
    : fail("signature did not validate against the published key");
}
