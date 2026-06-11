import { describe, it, expect } from "vitest";
import { parseEmailAuth } from "../src/email-auth.js";

describe("parseEmailAuth", () => {
  it("returns unknown for absent/empty header", () => {
    expect(parseEmailAuth(null)).toBe("unknown");
    expect(parseEmailAuth(undefined)).toBe("unknown");
    expect(parseEmailAuth("")).toBe("unknown");
  });

  it("passes a fully-authenticated message", () => {
    expect(
      parseEmailAuth(
        "mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com"
      )
    ).toBe("pass");
  });

  it("fails when DMARC fails (the spoof signal)", () => {
    expect(
      parseEmailAuth("mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail header.from=trusted.com")
    ).toBe("fail");
  });

  it("fails on DMARC fail even if SPF passes (alignment failure)", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=pass; dmarc=fail")).toBe("fail");
  });

  it("fails on SPF hard-fail with no passing DKIM", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=fail smtp.mailfrom=evil.com")).toBe("fail");
  });

  it("does NOT fail forwarded mail (SPF fail but DKIM pass)", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=fail; dkim=pass header.d=example.com")).toBe(
      "pass"
    );
  });

  it("passes when only SPF passes (domain has no DMARC/DKIM)", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=pass smtp.mailfrom=example.com")).toBe("pass");
  });

  it("returns unknown for softfail / neutral / none (not a hard fail)", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=softfail; dmarc=none")).toBe("unknown");
    expect(parseEmailAuth("mx.cloudflare.net; spf=neutral")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(parseEmailAuth("MX.CLOUDFLARE.NET; SPF=PASS; DMARC=PASS")).toBe("pass");
  });
});
