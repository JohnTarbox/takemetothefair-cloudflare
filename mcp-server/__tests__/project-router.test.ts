/**
 * OPE-327 (D-1) — project routing.
 *
 * The two properties that matter:
 *   1. MMATF's existing mail routes exactly as before (the regression clause).
 *   2. Unrecognised mail is UNROUTED, never guessed into a project — a wrong
 *      project means confidently wrong handling, which is worse than asking.
 */
import { describe, it, expect } from "vitest";
import {
  routeToProject,
  PROJECT_REGISTRY,
  type ProjectRoute,
} from "../src/inbound/project-router.js";

const sig = (to: string, from = "someone@example.com", subject: string | null = null) => ({
  toAddress: to,
  fromAddress: from,
  subject,
});

describe("routeToProject (OPE-327)", () => {
  it("routes every live MMATF address to mmatf", () => {
    // The regression clause: these are the addresses in production today.
    for (const a of [
      "submit@meetmeatthefair.com",
      "photos@meetmeatthefair.com",
      "corrections@meetmeatthefair.com",
      "subscribe@meetmeatthefair.com",
      "report@meetmeatthefair.com",
    ]) {
      expect(routeToProject(sig(a)).project, a).toBe("mmatf");
    }
  });

  it("is case- and subdomain-tolerant on the recipient domain", () => {
    expect(routeToProject(sig("Submit@MeetMeAtTheFair.com")).project).toBe("mmatf");
    expect(routeToProject(sig("x@mail.meetmeatthefair.com")).project).toBe("mmatf");
  });

  it("routes Cardworks mail to cardworks, not to the incumbent", () => {
    // The failure this whole ticket exists to prevent: a second project's mail
    // silently handled by MMATF's classifier.
    expect(routeToProject(sig("hello@mainecardworks.com")).project).toBe("cardworks");
  });

  it("returns UNROUTED rather than guessing", () => {
    const v = routeToProject(sig("hello@some-other-domain.com"));
    expect(v.project).toBe("UNROUTED");
    expect(v.basis).toBe("none");
    expect(v.reason).toContain("some-other-domain.com");
  });

  it("survives a malformed recipient without throwing", () => {
    expect(routeToProject(sig("not-an-address")).project).toBe("UNROUTED");
    expect(routeToProject(sig("")).project).toBe("UNROUTED");
  });

  it("lets a project claim mail at a SHARED address without a new domain", () => {
    // gemba@ stays one address (John's ruling 2), so D-3's per-project
    // anchoring has to work by claim, not by minting addresses.
    const withClaim: ProjectRoute[] = [
      {
        id: "engine-ops",
        domains: [],
        claims: (s) => (s.subject ?? "").toLowerCase().startsWith("[ops]"),
      },
      ...PROJECT_REGISTRY,
    ];
    expect(
      routeToProject(sig("gemba@example.com", "j@x.com", "[ops] queue stuck"), withClaim).project
    ).toBe("engine-ops");
    // …and a claim must not outrank an unambiguous domain match.
    expect(
      routeToProject(sig("submit@meetmeatthefair.com", "j@x.com", "[ops] hi"), withClaim).project
    ).toBe("mmatf");
  });

  it("registering a project is data, not a code change", () => {
    // The acceptance clause: a second project registers in config without
    // touching the core. Passing a registry proves the core is parameterised.
    const extended: ProjectRoute[] = [
      ...PROJECT_REGISTRY,
      { id: "engine-ops", domains: ["ops.example"] },
    ];
    expect(routeToProject(sig("a@ops.example"), extended).project).toBe("engine-ops");
    // The default registry is unaffected by that call.
    expect(routeToProject(sig("a@ops.example")).project).toBe("UNROUTED");
  });

  it("always explains itself", () => {
    for (const a of ["submit@meetmeatthefair.com", "x@nowhere.test", ""]) {
      expect(routeToProject(sig(a)).reason.length).toBeGreaterThan(5);
    }
  });
});
