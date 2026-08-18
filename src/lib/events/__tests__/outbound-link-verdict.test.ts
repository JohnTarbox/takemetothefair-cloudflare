/**
 * OPE-436 — the outbound links nobody was checking.
 *
 * `ticket_url` / `application_url` are the primary conversion action on an
 * event page, and 260 of them sit on live pages unverified. The specimen ran
 * ~7 months on our second-most-viewed Martha's Vineyard page:
 *
 *     http://www.marthasvinveyardagriculturalsociety.org/   ← transposed letter
 *
 * A domain that has never existed. It was found by accident while fixing
 * something else.
 *
 * These tests pin the three distinctions that decide whether such a checker is
 * trusted or muted — two of which are traps the ticket names explicitly.
 */
import { describe, expect, it } from "vitest";
import {
  classifyProbe,
  severityFor,
  shouldRaise,
  type LinkVerdict,
} from "../outbound-link-verdict";

describe("the specimen: a hostname that cannot exist", () => {
  it("classifies a DNS failure distinctly", () => {
    expect(classifyProbe({ status: null, dnsFailed: true })).toBe("dns_failure");
  });

  it("ranks it ERROR — above a 404", () => {
    // Different owner, not just different severity: an unresolvable host is
    // almost always OUR typo, while a 404 is usually organizer churn.
    expect(severityFor("dns_failure")).toBe("ERROR");
    expect(severityFor("http_404")).toBe("WARNING");
  });

  it("wins over every other signal present at once", () => {
    // A probe can report several things; DNS subsumes them.
    expect(classifyProbe({ status: null, dnsFailed: true, tlsFailed: true, timedOut: true })).toBe(
      "dns_failure"
    );
  });
});

describe("the OPE-424 trap: TLS broken, HTTP fine", () => {
  // Island Arts Association serves a self-signed cert on :443 while plain HTTP
  // works. Reporting that dead would falsely condemn exactly the small
  // organizer-run sites that are our highest-trust source class.
  const probe = { status: 200, tlsFailed: true, httpFallbackOk: true };

  it("is NOT treated as dead", () => {
    expect(classifyProbe(probe)).toBe("tls_error_http_ok");
  });

  it("is a NOTICE, not an error", () => {
    expect(severityFor("tls_error_http_ok")).toBe("NOTICE");
  });

  it("is checked before the generic TLS branch", () => {
    // Ordering guard: without the httpFallbackOk test first, this would fall
    // through to a failure verdict.
    expect(classifyProbe({ status: null, tlsFailed: true })).toBe("http_other");
    expect(classifyProbe(probe)).not.toBe("http_other");
  });
});

describe("a permanent redirect is an update, not a death", () => {
  it("classifies 301-to-live as permanent_redirect", () => {
    expect(
      classifyProbe({
        status: 200,
        permanentRedirect: true,
        finalUrl: "https://newsite.example/tickets",
      })
    ).toBe("permanent_redirect");
  });

  it("raises on the FIRST sighting — a 301 is stable information", () => {
    expect(shouldRaise("permanent_redirect", 1)).toBe(true);
  });

  it("does not treat a redirect that lands on a 404 as an update", () => {
    expect(classifyProbe({ status: 404, permanentRedirect: true })).toBe("http_404");
  });
});

describe("one failure is never rot", () => {
  it.each<[LinkVerdict, number]>([
    ["dns_failure", 2],
    ["http_404", 2],
    ["http_5xx", 3],
    ["timeout", 3],
  ])("%s needs %i consecutive failures", (verdict, needed) => {
    expect(shouldRaise(verdict, needed - 1)).toBe(false);
    expect(shouldRaise(verdict, needed)).toBe(true);
  });

  it("never raises on a healthy link", () => {
    expect(shouldRaise("ok", 99)).toBe(false);
    expect(severityFor("ok")).toBeNull();
  });

  it("treats 5xx and timeout as transient until they repeat", () => {
    // Servers have bad days. Alerting on the first is how a checker gets muted,
    // after which its silence reads as health — worse than no checker.
    expect(severityFor("http_5xx")).toBeNull();
    expect(severityFor("timeout")).toBeNull();
    expect(shouldRaise("http_5xx", 3)).toBe(true);
  });
});

describe("ordinary outcomes", () => {
  it.each([
    [200, "ok"],
    [204, "ok"],
    [302, "ok"],
    [404, "http_404"],
    [410, "http_404"],
    [500, "http_5xx"],
    [503, "http_5xx"],
    [403, "http_other"],
  ])("status %i → %s", (status, expected) => {
    expect(classifyProbe({ status })).toBe(expected);
  });

  it("handles no status at all", () => {
    expect(classifyProbe({ status: null })).toBe("http_other");
  });
});
