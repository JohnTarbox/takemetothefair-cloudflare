/**
 * OPE-328 (Demux D-3) — gemba@ is ONE address (John's ruling 2); the project is
 * the system's job. D-1's router decides by recipient domain first, which for
 * gemba@meetmeatthefair.com would tag EVERY observation `mmatf`. So a gemba
 * email is routed on its CONTENT: an explicit tag, else keyword claims. Exactly
 * one project → that project; none or several → held (ask, don't guess).
 */
import type { ProjectId } from "./project-router.js";

/** The project's Linear home for gemba observations. No anchor → held. */
export const GEMBA_ANCHORS: Partial<Record<ProjectId, string>> = {
  mmatf: "OPE-86",
};

const TAGS: Record<ProjectId, RegExp> = {
  mmatf: /(?:^|[\s[(#])(?:mmatf|fair)(?:[\s\])]|$)/i,
  cardworks: /(?:^|[\s[(#])cardworks(?:[\s\])]|$)/i,
  "engine-ops": /(?:^|[\s[(#])(?:engine|ops)(?:[\s\])]|$)/i,
};
const CLAIMS: Record<ProjectId, RegExp> = {
  mmatf:
    /\b(mmatf|meet ?me ?at ?the ?fair|meetmeatthefair|fairgoer|fair page|event page|vendor|promoter|venue)\b/i,
  cardworks: /\b(cardworks|maine cardworks|mainecardworks|storefront|greeting card)\b/i,
  "engine-ops": /\b(open engine|ledger|runner|OPE-\d+|lane)\b/i,
};

export interface GembaRouting {
  project: ProjectId | null;
  anchorIssue: string | null;
  status: "pending" | "held";
  reason: string;
}

export function routeGembaObservation(subject: string | null, body: string | null): GembaRouting {
  const subj = subject ?? "";
  const tagged = (Object.keys(TAGS) as ProjectId[]).filter((p) => TAGS[p].test(subj));
  const claimed =
    tagged.length > 0
      ? tagged
      : (Object.keys(CLAIMS) as ProjectId[]).filter((p) =>
          CLAIMS[p].test(`${subj}\n${body ?? ""}`)
        );
  const basis = tagged.length > 0 ? "subject tag" : "content claim";
  if (claimed.length !== 1) {
    return {
      project: null,
      anchorIssue: null,
      status: "held",
      reason:
        claimed.length === 0
          ? "no project tag or claim — which project is this about?"
          : `ambiguous (${basis}: ${claimed.join(", ")}) — which project is this about?`,
    };
  }
  const project = claimed[0];
  const anchor = GEMBA_ANCHORS[project] ?? null;
  return anchor
    ? { project, anchorIssue: anchor, status: "pending", reason: `${basis}: ${project}` }
    : {
        project,
        anchorIssue: null,
        status: "held",
        reason: `${basis}: ${project}, but ${project} has no gemba anchor issue yet`,
      };
}
