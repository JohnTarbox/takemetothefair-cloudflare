/**
 * OPE-237 — realness screen.
 *
 * The fixtures below are REAL production signups (prod D1, 2026-07-27), not
 * invented examples. That matters: a scoring model tuned on made-up input
 * scores beautifully on made-up input. Every threshold here is justified by
 * how it ranks actual vendors who actually registered.
 */
import { describe, it, expect } from "vitest";
import {
  assessRealness,
  computeCoherenceSignals,
  scoreRealness,
  type CoherenceInput,
} from "../realness";

/** The signup that motivated the ticket — analyst screened this one by hand. */
const CD_CERAMICS: CoherenceInput = {
  claimantName: "Colette Dewan",
  businessName: "CD Ceramics and Florals",
  email: "cdceramicsandflorals@gmail.com",
  emailVerified: true,
  website: null,
  description: "Handmade ceramics and dried floral arrangements.",
};

/** Textbook domain-match: email domain === website domain. */
const SKVL: CoherenceInput = {
  claimantName: "Shazad Chikliwala",
  businessName: "SKVL Organic World Inc.",
  email: "shazad.chikliwala@moreA2.com",
  emailVerified: false,
  website: "https://www.morea2.com",
  description: "Organic products.",
};

describe("computeCoherenceSignals (OPE-237)", () => {
  it("spots the business name inside a generic-Gmail local part", () => {
    const s = computeCoherenceSignals(CD_CERAMICS);
    expect(s.emailMatchesBusiness).toBe(true);
    expect(s.freeMailProvider).toBe(true);
    // Gmail is NOT held against her — it just carries no domain signal.
    expect(s.emailDomainMatchesWebsite).toBe(false);
  });

  it("spots the initials pattern the analyst found by hand (Colette Dewan → CD Ceramics)", () => {
    expect(computeCoherenceSignals(CD_CERAMICS).claimantNameInBusiness).toBe(true);
  });

  it("detects the domain-match rung (OPE-64) case-insensitively and ignoring www.", () => {
    const s = computeCoherenceSignals(SKVL);
    expect(s.emailDomainMatchesWebsite).toBe(true);
    expect(s.websiteProvided).toBe(true);
    expect(s.freeMailProvider).toBe(false);
  });

  it("does not let a stopword fake a name match", () => {
    // "The Sourced Parlor" must not match on "the".
    const s = computeCoherenceSignals({
      claimantName: "Alex Rivera",
      businessName: "The Sourced Parlor",
      email: "thebest@gmail.com",
      emailVerified: true,
    });
    expect(s.emailMatchesBusiness).toBe(false);
    expect(s.claimantNameInBusiness).toBe(false);
  });

  it("tolerates missing/garbage inputs rather than throwing", () => {
    const s = computeCoherenceSignals({
      claimantName: null,
      businessName: "Douse",
      email: "not-an-email",
      emailVerified: false,
      website: "::::not a url::::",
    });
    expect(s.websiteProvided).toBe(false);
    expect(s.claimantNameInBusiness).toBe(false);
    expect(s.spamFlags).toEqual([]);
  });
});

describe("spam fingerprints (OPE-237)", () => {
  it("flags a link farm (2+ URLs), but not a single legitimate link", () => {
    const one = computeCoherenceSignals({
      claimantName: "Pat Lee",
      businessName: "Bri Paints",
      email: "pat@gmail.com",
      emailVerified: true,
      description: "See our work at https://bripaints.com",
    });
    expect(one.spamFlags).not.toContain("injected_urls");

    const many = computeCoherenceSignals({
      claimantName: "Pat Lee",
      businessName: "Bri Paints",
      email: "pat@gmail.com",
      emailVerified: true,
      description: "Cheap https://a.example www.b.example https://c.example",
    });
    expect(many.spamFlags).toContain("injected_urls");
  });

  it("flags keyword stuffing only when there is enough text for the ratio to mean anything", () => {
    const short = computeCoherenceSignals({
      claimantName: "Sam",
      businessName: "Kewl Kandylz",
      email: "sam@gmail.com",
      emailVerified: true,
      description: "Candy candy candy.",
    });
    expect(short.spamFlags).not.toContain("keyword_stuffing");

    const stuffed = computeCoherenceSignals({
      claimantName: "Sam",
      businessName: "Kewl Kandylz",
      email: "sam@gmail.com",
      emailVerified: true,
      description:
        "candy candy candy candy candy candy best sweets treats fudge caramel candy candy",
    });
    expect(stuffed.spamFlags).toContain("keyword_stuffing");
  });

  it("flags gibberish names without libelling real short ones", () => {
    const real = computeCoherenceSignals({
      claimantName: "Jo Fox",
      businessName: "Douse",
      email: "jo@gmail.com",
      emailVerified: true,
    });
    expect(real.spamFlags).not.toContain("gibberish_business_name");

    for (const junk of ["xkcdfgh", "88291726", "zzzz"]) {
      const s = computeCoherenceSignals({
        claimantName: null,
        businessName: junk,
        email: "x@x.com",
        emailVerified: false,
      });
      expect(s.spamFlags, `expected ${junk} flagged`).toContain("gibberish_business_name");
    }
  });
});

describe("scoreRealness — banding (OPE-237)", () => {
  it("ranks the real analyst case as reviewable, not suspect", () => {
    // Verified email + business-referencing address + initials match, but no
    // web presence. A human should see it, and should not see it flagged.
    const r = assessRealness(CD_CERAMICS, "NONE");
    expect(r.band).toBe("NEEDS_REVIEW");
    expect(r.score).toBeGreaterThanOrEqual(20);
    expect(r.reasons.join(" ")).toContain("verified");
  });

  it("promotes the domain-match case to LIKELY_REAL once its site is confirmed live", () => {
    const r = assessRealness({ ...SKVL, emailVerified: true }, "STRONG");
    expect(r.band).toBe("LIKELY_REAL");
    expect(r.score).toBeGreaterThanOrEqual(60);
  });

  it("scores a dead declared presence BELOW an unfound one — the ticket's caution case", () => {
    // Signals held CONSTANT — only the corroboration outcome differs. Comparing
    // against a signup with no website at all would change three inputs at once
    // (it also forfeits the domain-match and website-provided awards), which
    // would make this pass for reasons unrelated to the caution rule.
    const dead = assessRealness(SKVL, "WEAK");
    const notFound = assessRealness(SKVL, "NONE");
    expect(dead.score).toBeLessThan(notFound.score);
    expect(dead.reasons.join(" ")).toContain("CAUTION");
  });

  it("does not let a dead marketing site erase a genuine email-domain match", () => {
    // morea2.com still receives their mail even if the site is down; the
    // domain-match rung is evidence independent of whether HTML renders.
    const dead = assessRealness(SKVL, "WEAK");
    const noPresenceAtAll = assessRealness(
      { ...SKVL, website: null, email: "shazad@gmail.com" },
      "NONE"
    );
    expect(dead.score).toBeGreaterThan(noPresenceAtAll.score);
  });

  it("never reports unchecked corroboration as clean", () => {
    const r = assessRealness(CD_CERAMICS, "UNAVAILABLE");
    expect(r.reasons.join(" ")).toContain("not checked");
    // and it earns no corroboration points
    expect(r.score).toBe(assessRealness(CD_CERAMICS, "NONE").score);
  });

  it("drives an obvious spam signup to SUSPECT", () => {
    const r = assessRealness(
      {
        claimantName: null,
        businessName: "xkcdfgh",
        email: "a1b2@mailinator.com",
        emailVerified: false,
        description: "buy now https://a.example https://b.example cheap cheap cheap",
      },
      "NONE"
    );
    expect(r.band).toBe("SUSPECT");
  });

  it("clamps to 0..100 no matter how many negatives pile up", () => {
    const r = scoreRealness(
      {
        emailVerified: false,
        emailMatchesBusiness: false,
        emailDomainMatchesWebsite: false,
        freeMailProvider: false,
        claimantNameInBusiness: false,
        websiteProvided: true,
        spamFlags: ["injected_urls", "keyword_stuffing", "gibberish_business_name"],
        selfReportedEventCount: 0,
      },
      "WEAK"
    );
    expect(r.score).toBe(0);
    expect(r.band).toBe("SUSPECT");
  });

  it("is purely additive — every awarded point has a matching reason line", () => {
    // The reasons list is the audit trail a reviewer reads; a silent point
    // would make the score unarguable.
    const r = assessRealness({ ...SKVL, emailVerified: true }, "STRONG");
    expect(r.signals.emailDomainMatchesWebsite).toBe(true);
    // Every awarded signal is spelled out, and no reason line is blank.
    const joined = r.reasons.join(" | ");
    expect(joined).toContain("verified");
    expect(joined).toContain("domain matches");
    expect(joined).toContain("live");
    expect(r.reasons.every((line) => line.trim().length > 0)).toBe(true);
  });

  it("NEVER returns an approve/reject decision — it only informs a human", () => {
    const r = assessRealness(CD_CERAMICS, "STRONG");
    expect(Object.keys(r).sort()).toEqual(
      ["band", "corroboration", "reasons", "score", "signals"].sort()
    );
  });
});

/**
 * OPE-239 — vendor self-attested fair participation as a trust input.
 *
 * The rule that matters is ASYMMETRY: naming a fair helps, naming none must
 * cost nothing. Our roster coverage is too sparse for silence to be evidence,
 * so a penalty here would quietly punish honest vendors of events whose
 * organizers simply never publish a list.
 */
describe("self-reported fair participation (OPE-239)", () => {
  it("boosts a vendor who can name one of our fairs", () => {
    const without = assessRealness(CD_CERAMICS, "NONE");
    const with1 = assessRealness({ ...CD_CERAMICS, selfReportedEventCount: 1 }, "NONE");
    expect(with1.score).toBeGreaterThan(without.score);
    expect(with1.reasons.join(" ")).toContain("exhibited at");
  });

  it("naming NONE is not a penalty — the asymmetry the ticket requires", () => {
    const zero = assessRealness({ ...CD_CERAMICS, selfReportedEventCount: 0 }, "NONE");
    const absent = assessRealness(CD_CERAMICS, "NONE");
    expect(zero.score).toBe(absent.score);
    // and no reason line implies anything negative about having none
    expect(zero.reasons.join(" ")).not.toContain("exhibited at");
  });

  it("rewards an established pattern but caps it — 20 ticks is not 20x one tick", () => {
    const one = assessRealness({ ...CD_CERAMICS, selfReportedEventCount: 1 }, "NONE");
    const three = assessRealness({ ...CD_CERAMICS, selfReportedEventCount: 3 }, "NONE");
    const twenty = assessRealness({ ...CD_CERAMICS, selfReportedEventCount: 20 }, "NONE");
    expect(three.score).toBeGreaterThan(one.score);
    expect(twenty.score).toBe(three.score);
  });

  it("cannot rescue an obvious spam signup on its own", () => {
    // Self-attestation is cheap to fabricate, so it must not outweigh spam
    // fingerprints — a spammer ticking boxes stays SUSPECT.
    const r = assessRealness(
      {
        claimantName: null,
        businessName: "xkcdfgh",
        email: "a1b2@mailinator.com",
        emailVerified: false,
        description: "buy now https://a.example https://b.example cheap cheap cheap",
        selfReportedEventCount: 20,
      },
      "NONE"
    );
    expect(r.band).toBe("SUSPECT");
  });

  it("treats a negative count as zero rather than trusting the caller", () => {
    const r = assessRealness({ ...CD_CERAMICS, selfReportedEventCount: -5 }, "NONE");
    expect(r.signals.selfReportedEventCount).toBe(0);
  });
});
