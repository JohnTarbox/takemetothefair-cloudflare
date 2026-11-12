/**
 * OPE-1613 — which feed events MMATF publishes.
 *
 * Organizer categories are NOT trusted (OHTM tags November events "Spring"), so
 * the defaults key on title, description and the organizer address. On the
 * 2026-11-10 OHTM read ~18 of 20 items were kids' STEM programs or closures, so
 * these rules matter more than the parser. Every rule is overridable per
 * promoter via `promoter_event_feeds.inclusion_rules` (JSON).
 *
 * Order: closures drop first, then an explicit title include wins, then the
 * program drops, then the organizer drop, then multi-day keep, then the
 * default. Every verdict carries the rule that decided it, so an operator
 * reading a dropped item can see why without re-deriving it.
 *
 * OPE-1629: a program pattern in the TITLE drops the item on its own. In the
 * DESCRIPTION it drops the item only when the description also reads like a
 * program (`programDescriptionSignals`: registration, an age or grade band, a
 * session/class schedule). Marshfield Fair's monthly Indoor Farmers' Market
 * says "live music, and kids activities" and was dropped as a children's
 * program; OHTM's real programs all say so in the title or come from
 * education@, so they are still dropped.
 */
import type { FeedEvent } from "./feed-event";

export interface FeedInclusionRules {
  /** Case-insensitive regex sources. A title match always keeps the item. */
  includeTitlePatterns: string[];
  /** Closures and similar — dropped. */
  excludeTitlePatterns: string[];
  /**
   * Recurring children's / education programs — dropped. A title match drops on
   * its own; a description match drops only alongside a `programDescriptionSignals`
   * match (OPE-1629).
   */
  excludeProgramPatterns: string[];
  /**
   * Wording that marks a DESCRIPTION as a program rather than a public event
   * that mentions kids: registration, an age/grade band, a session or class
   * schedule. Case-insensitive regex sources.
   */
  programDescriptionSignals: string[];
  /** Organizer addresses whose items are dropped (e.g. education@). Local-part or full address. */
  excludeOrganizerEmails: string[];
  /** Keep items that span more than one calendar day. */
  keepMultiDay: boolean;
  /** What happens to an item no rule decided. */
  defaultInclude: boolean;
}

export const DEFAULT_INCLUSION_RULES: FeedInclusionRules = {
  includeTitlePatterns: [
    "festival",
    "fair",
    "show",
    "airshow",
    "jamboree",
    "rally",
    "auction",
    // OPE-1629 — public markets and sales are never a children's program.
    "market",
    "bazaar",
    "flea",
    "antique",
    "expo",
    "craft",
  ],
  excludeTitlePatterns: ["\\[closed\\]", "^closed\\b", "museum closed", "\\bclosure\\b"],
  excludeProgramPatterns: [
    "\\bkids?\\b",
    "\\bjunior\\b",
    "\\bstem\\b",
    "\\bhomeschool",
    "\\bcamp\\b",
    "\\bstory ?time\\b",
    "\\bages \\d",
  ],
  programDescriptionSignals: [
    "\\bregist(?:er|ration|ering)\\b",
    "\\bpre-?regist",
    "\\benroll",
    "\\bsign[- ]?ups?\\b",
    "\\bages? \\d",
    "\\bages? range\\b",
    "\\bgrades? (?:k|pre-?k|\\d)",
    "\\b(?:pre-?)?k ?[-–] ?\\d{1,2}(?:th)?\\b",
    "\\bafter[- ]school\\b",
    "\\bsessions?\\b",
    "\\bclass(?:es)?\\b",
    "\\bprogram(?:ming)? runs\\b",
    "\\bweekly (?:program|class|session)",
  ],
  excludeOrganizerEmails: ["education@"],
  keepMultiDay: true,
  defaultInclude: true,
};

export function parseInclusionRules(json: string | null | undefined): FeedInclusionRules {
  if (!json) return DEFAULT_INCLUSION_RULES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("inclusion_rules is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("inclusion_rules must be an object");
  return { ...DEFAULT_INCLUSION_RULES, ...(parsed as Partial<FeedInclusionRules>) };
}

export interface InclusionVerdict {
  included: boolean;
  reason: string;
}

const anyMatch = (patterns: string[], text: string): string | null => {
  for (const p of patterns) if (new RegExp(p, "i").test(text)) return p;
  return null;
};

export function decideInclusion(ev: FeedEvent, rules: FeedInclusionRules): InclusionVerdict {
  const inc = anyMatch(rules.includeTitlePatterns, ev.title);
  const closed = anyMatch(rules.excludeTitlePatterns, ev.title);
  // A closure is dropped even if its title also says "show" ("[Closed] Truck Show day").
  if (closed) return { included: false, reason: `title matches closure /${closed}/` };
  if (inc) return { included: true, reason: `title matches /${inc}/` };
  const progTitle = anyMatch(rules.excludeProgramPatterns, ev.title);
  if (progTitle) return { included: false, reason: `program title matches /${progTitle}/` };
  const progDesc = anyMatch(rules.excludeProgramPatterns, ev.description);
  if (progDesc) {
    const signal = anyMatch(rules.programDescriptionSignals, ev.description);
    if (signal) {
      return {
        included: false,
        reason: `program description matches /${progDesc}/ and /${signal}/`,
      };
    }
  }
  const org = ev.organizerEmails.find((e) =>
    rules.excludeOrganizerEmails.some((x) =>
      x.includes("@") && !x.startsWith("@") && !x.endsWith("@") ? e === x : e.startsWith(x)
    )
  );
  if (org) return { included: false, reason: `organizer ${org} is excluded` };
  if (rules.keepMultiDay && ev.startDate && ev.endDate && ev.endDate > ev.startDate) {
    return { included: true, reason: "multi-day event" };
  }
  return {
    included: rules.defaultInclude,
    reason: rules.defaultInclude ? "default include" : "default exclude",
  };
}
