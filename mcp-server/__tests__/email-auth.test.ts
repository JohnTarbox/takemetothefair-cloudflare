import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEmailAuth, firstAuthResultsHeader } from "../src/email-auth.js";

/** Shape of a real Cloudflare header on John's own Gmail mail (prod, 2026-10). */
const CF_GMAIL_ALIGNED =
  "mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104 header.b=ZqZ/iZfx; " +
  "dmarc=pass header.from=gmail.com policy.dmarc=none; " +
  "spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-yx2-x11.google.com) smtp.helo=mail-yx2-x11.google.com; " +
  "spf=pass (mx.cloudflare.net: domain of sender@gmail.com designates 2607:f8b0:4864:41::11 as permitted sender) smtp.mailfrom=sender@gmail.com; " +
  'arc=pass smtp.remote-ip="2607:f8b0:4864:41::11"';

/** Cloudflare's header for UNSIGNED mail at a domain with no DMARC: no dkim=, dmarc=none. */
const CF_UNSIGNED_NO_DMARC =
  "mx.cloudflare.net; dmarc=none header.from=nodmarc.example; " +
  "spf=none (mx.cloudflare.net: no SPF records found for postmaster@attacker.example) smtp.helo=attacker.example; " +
  "spf=none (mx.cloudflare.net: no SPF records found for x@attacker.example) smtp.mailfrom=x@attacker.example; " +
  "arc=none smtp.remote-ip=203.0.113.9";

describe("parseEmailAuth — OPE-1369: Cloudflare's header only, aligned DMARC only", () => {
  it("a forged trailing A-R header with dkim=pass does NOT pass", () => {
    // The exact attack: Cloudflare's header has no dkim= for unsigned mail, so
    // the old first-match-anywhere parser read the sender's own dkim=pass.
    const joined = `${CF_UNSIGNED_NO_DMARC}, evil.example; dkim=pass header.d=nodmarc.example; dmarc=pass header.from=nodmarc.example`;
    expect(parseEmailAuth(joined)).not.toBe("pass");
    expect(parseEmailAuth(joined, "trusted@nodmarc.example")).not.toBe("pass");
    expect(parseEmailAuth(joined, "trusted@nodmarc.example")).toBe("unknown");
  });

  it("a forged trailing header that CLAIMS mx.cloudflare.net is ignored too", () => {
    const joined = `${CF_UNSIGNED_NO_DMARC}, mx.cloudflare.net; dkim=pass header.d=nodmarc.example; dmarc=pass header.from=nodmarc.example`;
    expect(parseEmailAuth(joined, "trusted@nodmarc.example")).toBe("unknown");
  });

  it("a forged header PREPENDED with a foreign authserv-id is not Cloudflare's → unknown", () => {
    const joined = `evil.example; dmarc=pass header.from=gmail.com, ${CF_GMAIL_ALIGNED}`;
    expect(parseEmailAuth(joined, "sender@gmail.com")).toBe("unknown");
  });

  it("a real Cloudflare header with aligned dmarc=pass passes", () => {
    expect(parseEmailAuth(CF_GMAIL_ALIGNED, "sender@gmail.com")).toBe("pass");
    expect(parseEmailAuth(CF_GMAIL_ALIGNED)).toBe("pass");
  });

  it("aligned pass survives trailing headers (Microsoft's authserv-less one, a forwarding hop)", () => {
    const joined = `${CF_GMAIL_ALIGNED}, dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=gmail.com;`;
    expect(parseEmailAuth(joined, "sender@gmail.com")).toBe("pass");
  });

  it("dmarc=pass for a DIFFERENT domain than the From is not a pass", () => {
    expect(parseEmailAuth(CF_GMAIL_ALIGNED, "trusted@pimboat.com")).toBe("partial");
  });

  it("dmarc=pass without header.from is not a pass", () => {
    expect(parseEmailAuth("mx.cloudflare.net; dmarc=pass; spf=pass", "a@b.example")).toBe(
      "partial"
    );
  });

  it("SPF-only pass → partial (no DMARC, anyone can pass SPF for their own MAIL FROM)", () => {
    expect(
      parseEmailAuth("mx.cloudflare.net; spf=pass smtp.mailfrom=x@example.com", "x@example.com")
    ).toBe("partial");
  });

  it("DKIM pass with dmarc=none → partial", () => {
    expect(
      parseEmailAuth(
        "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=none header.from=example.com policy.dmarc=none",
        "x@example.com"
      )
    ).toBe("partial");
  });

  it("`policy.dmarc=` is not read as the DMARC result", () => {
    expect(parseEmailAuth("mx.cloudflare.net; policy.dmarc=pass; spf=none", "x@example.com")).toBe(
      "unknown"
    );
  });

  it("returns unknown for absent/empty header", () => {
    expect(parseEmailAuth(null)).toBe("unknown");
    expect(parseEmailAuth(undefined)).toBe("unknown");
    expect(parseEmailAuth("")).toBe("unknown");
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

  it("forwarded mail (SPF fail but DKIM pass, no DMARC) is partial, not fail", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=fail; dkim=pass header.d=example.com")).toBe(
      "partial"
    );
  });

  it("returns unknown for softfail / neutral / none (not a hard fail)", () => {
    expect(parseEmailAuth("mx.cloudflare.net; spf=softfail; dmarc=none")).toBe("unknown");
    expect(parseEmailAuth("mx.cloudflare.net; spf=neutral")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(
      parseEmailAuth("MX.CLOUDFLARE.NET; SPF=PASS; DMARC=PASS HEADER.FROM=X.TEST", "A@X.TEST")
    ).toBe("pass");
  });
});

describe("firstAuthResultsHeader", () => {
  it("splits at the first top-level comma, not one inside a comment or quotes", () => {
    expect(
      firstAuthResultsHeader('mx.a; spf=pass (x, y) smtp.remote-ip="1,2", mx.b; dkim=pass')
    ).toBe('mx.a; spf=pass (x, y) smtp.remote-ip="1,2"');
  });

  it("returns the whole value when there is one header", () => {
    expect(firstAuthResultsHeader("mx.a; spf=pass")).toBe("mx.a; spf=pass");
  });
});

describe("OPE-1369 wiring — the handler honours trust only on an aligned pass (source-level)", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/email-handler.ts", import.meta.url)),
    "utf8"
  );
  const routingAt = SRC.indexOf("async function computeRouting(");
  const routing = SRC.slice(routingAt);

  it("computeRouting exists where we look (else the checks below are inert)", () => {
    expect(routingAt).toBeGreaterThan(-1);
  });

  it('the trusted fast-path requires emailAuth === "pass" (unknown/partial no longer fail open)', () => {
    expect(routing).toMatch(/senderTrust === "trusted" && emailAuth === "pass" && env\.AI/);
    expect(routing).not.toMatch(/emailAuth !== "fail"/);
  });

  it("the gate verdict is computed against the From address the trust tier keys on", () => {
    expect(SRC).toMatch(
      /parseEmailAuth\(message\.headers\?\.get\("Authentication-Results"\), fromAddr\)/
    );
  });
});
