import { describe, it, expect } from "vitest";
import { isBlockedSsrfHost } from "./ssrf-guard";

describe("isBlockedSsrfHost", () => {
  describe("blocks internal/loopback names", () => {
    it.each(["localhost", "app.localhost", "foo.local", "host.internal", "box.lan", "", "  "])(
      "blocks %s",
      (h) => expect(isBlockedSsrfHost(h)).toBe(true)
    );
    it("blocks metadata.google.internal (GCP metadata)", () =>
      expect(isBlockedSsrfHost("metadata.google.internal")).toBe(true));
  });

  describe("blocks private/reserved IPv4 (dotted-decimal)", () => {
    it.each([
      "127.0.0.1",
      "10.1.2.3",
      "172.16.5.5",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254", // AWS/GCP metadata
      "0.0.0.0",
      "100.64.0.1", // CGNAT
    ])("blocks %s", (h) => expect(isBlockedSsrfHost(h)).toBe(true));
  });

  describe("blocks encoded-IP bypasses (the gaps this helper closes)", () => {
    it("blocks decimal-integer 127.0.0.1 (2130706433)", () =>
      expect(isBlockedSsrfHost("2130706433")).toBe(true));
    it("blocks hex 127.0.0.1 (0x7f000001)", () =>
      expect(isBlockedSsrfHost("0x7f000001")).toBe(true));
    it("blocks octal-dotted 127.0.0.1 (0177.0.0.1)", () =>
      expect(isBlockedSsrfHost("0177.0.0.1")).toBe(true));
    it("blocks hex-dotted (0x7f.0.0.1)", () => expect(isBlockedSsrfHost("0x7f.0.0.1")).toBe(true));
    it("blocks decimal-integer 169.254.169.254 (2852039166)", () =>
      expect(isBlockedSsrfHost("2852039166")).toBe(true));
  });

  describe("blocks IPv6 loopback / ULA / link-local / mapped", () => {
    it.each([
      "[::1]",
      "[0:0:0:0:0:0:0:1]", // expanded loopback
      "[::]", // unspecified
      "[fc00::1]", // ULA
      "[fd12:3456::1]", // ULA
      "[fe80::1]", // link-local
      "[::ffff:127.0.0.1]", // v4-mapped loopback
      "[::ffff:169.254.169.254]", // v4-mapped metadata
    ])("blocks %s", (h) => expect(isBlockedSsrfHost(h)).toBe(true));
  });

  describe("allows legitimate public hosts", () => {
    it.each([
      "example.com",
      "meetmeatthefair.com",
      "sub.domain.example.co.uk",
      "1.example.com", // numeric label but a real DNS name
      "example123.com",
      "93.184.216.34", // public IPv4
      "8.8.8.8", // public DNS
      "1.1.1.1", // Cloudflare DNS (public)
      "[2001:db8::1]", // public/doc IPv6, not loopback/ula/linklocal
    ])("allows %s", (h) => expect(isBlockedSsrfHost(h)).toBe(false));
  });
});

// OPE-1370 (SSRF7) — the gaps the audit found, fed through URL.hostname the
// way every caller does, so URL normalization is part of the test.
describe("OPE-1370 gaps, as URL.hostname presents them", () => {
  const host = (u: string) => new URL(u).hostname;
  it.each([
    "http://localhost./",
    "http://LOCALHOST../",
    "http://app.localhost./",
    "http://metadata.google.internal./",
    "http://foo.local./",
    "http://127.0.0.1./",
    "http://[::7f00:1]/", // IPv4-compatible 127.0.0.1
    "http://[::127.0.0.1]/", // normalizes to [::7f00:1]
    "http://[0:0:0:0:0:0:7f00:1]/",
    "http://[::a9fe:a9fe]/", // IPv4-compatible 169.254.169.254
    "http://[::8.8.8.8]/", // the whole deprecated ::/96 is refused
    "http://[::ffff:7f00:1]/", // mapped, hex form
    "http://[::ffff:0:7f00:1]/", // translated
    "http://[64:ff9b::127.0.0.1]/", // NAT64 of loopback
    "http://[64:ff9b:1::1]/", // local-use NAT64
    "http://[2002:7f00:1::]/", // 6to4 of 127.0.0.1
    "http://[2002:a00:1::]/", // 6to4 of 10.0.0.1
    "http://[fec0::1]/", // site-local
    "http://[ff02::1]/", // multicast
    "http://[febf::1]/", // top of fe80::/10
    "http://224.0.0.1/",
    "http://255.255.255.255/",
  ])("blocks %s", (u) => expect(isBlockedSsrfHost(host(u))).toBe(true));

  it.each([
    "http://example.com./",
    "http://[2606:4700:4700::1111]/", // Cloudflare public DNS
    "http://[::ffff:8.8.8.8]/", // mapped PUBLIC v4 → allowed (decoded, not guessed)
    "http://[64:ff9b::8.8.8.8]/",
    "http://[2002:808:808::]/", // 6to4 of 8.8.8.8
  ])("allows %s", (u) => expect(isBlockedSsrfHost(host(u))).toBe(false));

  it("blocks a malformed bracketed literal rather than passing it", () =>
    expect(isBlockedSsrfHost("[1:2:3]")).toBe(true));
  it("blocks a bare (unbracketed) IPv6 loopback", () =>
    expect(isBlockedSsrfHost("::1")).toBe(true));
  it("blocks the raw (un-normalized) IPv4-compatible dotted form", () =>
    expect(isBlockedSsrfHost("[::127.0.0.1]")).toBe(true));
});
