/**
 * OPE-327 (Demux D-1) — first-stage PROJECT router.
 *
 * Today the inbound pipeline assumes every email is MMATF's: `resolveIntent`
 * maps a recipient address straight to an MMATF intent. That works while there
 * is one project and silently mis-files everything the moment there are two.
 *
 * So routing happens in two stages: decide WHOSE mail this is, then hand it to
 * that project's own intent classifier.
 *
 * Per John's ruling 3, this is SHARED infrastructure — MMATF is the first
 * tenant, not the owner. Registering another project is a `ProjectRoute` entry
 * in the registry below: its own address patterns, its own classifier. No
 * change to this file's logic, and no fork of the pipeline.
 *
 * ── Why a registry rather than if/else ────────────────────────────────────
 * An if/else chain makes "add a project" a core edit, and core edits to a
 * router that every inbound email passes through are exactly what nobody wants
 * to review under time pressure. A registry makes the risky part (the routing
 * algorithm) stable and the changing part (which projects exist) data.
 *
 * ── The fallback is a QUESTION, never a failure ───────────────────────────
 * When no project matches, the answer is UNROUTED, which the caller turns into
 * a hold-and-ask. A terminal "we couldn't understand your message" reply is the
 * failure mode OPE-315 and OPE-325 both fixed one lane at a time; the router
 * makes it structurally unavailable.
 */

/** Stable project ids. Adding one means adding a ProjectRoute, nothing else. */
export type ProjectId = "mmatf" | "cardworks" | "engine-ops";

/** What the router gets to look at. Deliberately small — anything richer
 *  (attachments, OCR) belongs to a project's own classifier, after routing. */
export interface RoutingSignals {
  /** Envelope recipient, e.g. "submit@meetmeatthefair.com". */
  toAddress: string;
  /** Envelope sender. */
  fromAddress: string;
  subject: string | null;
}

export interface ProjectRoute {
  id: ProjectId;
  /** Hostnames this project owns. Matched on the recipient's domain. */
  domains: string[];
  /**
   * Optional extra signal for mail that reaches a SHARED address (gemba@ stays
   * one address per John's ruling 2, so D-3's per-project anchoring hooks in
   * here rather than by minting new addresses).
   */
  claims?: (signals: RoutingSignals) => boolean;
}

export interface RoutingVerdict {
  project: ProjectId | "UNROUTED";
  /** Why — logged so routing precision is measurable, per the ticket. */
  reason: string;
  /** Which signal decided it. Useful when precision turns out to be poor: it
   *  says whether to fix the domains list or the claims predicate. */
  basis: "domain" | "claim" | "none";
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .toLowerCase()
        .trim();
}

/**
 * The registry. MMATF is first because it is the only project with live
 * inbound today — the others are declared so that registering them is a data
 * change, and so the shape is exercised rather than hypothetical.
 */
export const PROJECT_REGISTRY: ProjectRoute[] = [
  {
    id: "mmatf",
    domains: ["meetmeatthefair.com"],
  },
  {
    id: "cardworks",
    domains: ["mainecardworks.com"],
  },
];

/**
 * Route an inbound email to a project.
 *
 * Domain first (unambiguous, cheap), then any project's `claims` predicate for
 * shared addresses. No match is UNROUTED — never a guess. Mis-routing mail into
 * the wrong project's classifier produces confidently wrong handling, which is
 * worse than asking.
 */
export function routeToProject(
  signals: RoutingSignals,
  registry: ProjectRoute[] = PROJECT_REGISTRY
): RoutingVerdict {
  const domain = domainOf(signals.toAddress);

  if (domain) {
    for (const route of registry) {
      if (route.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
        return { project: route.id, reason: `recipient domain ${domain}`, basis: "domain" };
      }
    }
  }

  for (const route of registry) {
    if (route.claims?.(signals)) {
      return { project: route.id, reason: `claimed by ${route.id}`, basis: "claim" };
    }
  }

  return {
    project: "UNROUTED",
    reason: domain ? `no project owns ${domain}` : "recipient address had no parseable domain",
    basis: "none",
  };
}
