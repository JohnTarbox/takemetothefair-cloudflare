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
 *
 * OPE-1682: a REGISTERED promoter may opt in to listing its camps and
 * workshops (`include_camps_workshops`, John's ruling 2026-11-18: registered
 * promoters only). With the opt-in active, an item whose title or a category
 * marks it a camp or workshop is kept even though the program rule (`camp`)
 * or the organizer rule (education@) would drop it. Closures still drop first.
 * Every other program item stays dropped. Whether the opt-in is ACTIVE —
 * setting on AND promoter registered — is the caller's decision
 * (`campsWorkshopsOptInActive`), made from the promoter row at read time, so
 * a promoter that stops being registered stops getting the exception.
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

/** OPE-1682 — what marks an item as a camp or workshop (title or a category). */
export const CAMP_WORKSHOP_PATTERNS: string[] = ["\\bcamps?\\b", "\\bworkshops?\\b"];

export interface InclusionOptions {
  /** OPE-1682 — the promoter's camps/workshops opt-in is ACTIVE (set and registered). */
  campsWorkshopsOptIn?: boolean;
}

/** The promoter fields that decide whether its camps/workshops opt-in applies. */
export interface CampsWorkshopsPromoter {
  includeCampsWorkshops: boolean | null;
  claimed: boolean | null;
  userId: string | null;
}

/**
 * OPE-1682 — a promoter is REGISTERED when it has been claimed by a user
 * account (`claimed` with a linked `user_id`, the OPE-63 claim state).
 */
export function isRegisteredPromoter(
  p: Pick<CampsWorkshopsPromoter, "claimed" | "userId">
): boolean {
  return p.claimed === true && !!p.userId;
}

/** OPE-1682 — the setting applies only while the promoter is registered. */
export function campsWorkshopsOptInActive(p: CampsWorkshopsPromoter | null | undefined): boolean {
  return !!p && p.includeCampsWorkshops === true && isRegisteredPromoter(p);
}

export interface InclusionVerdict {
  included: boolean;
  reason: string;
}

const anyMatch = (patterns: string[], text: string): string | null => {
  for (const p of patterns) if (new RegExp(p, "i").test(text)) return p;
  return null;
};

export function decideInclusion(
  ev: FeedEvent,
  rules: FeedInclusionRules,
  opts: InclusionOptions = {}
): InclusionVerdict {
  const inc = anyMatch(rules.includeTitlePatterns, ev.title);
  const closed = anyMatch(rules.excludeTitlePatterns, ev.title);
  // A closure is dropped even if its title also says "show" ("[Closed] Truck Show day").
  if (closed) return { included: false, reason: `title matches closure /${closed}/` };
  if (opts.campsWorkshopsOptIn) {
    // OPE-1682 — ahead of the program and organizer drops, which are exactly
    // the rules that would otherwise discard a camp.
    const campTitle = anyMatch(CAMP_WORKSHOP_PATTERNS, ev.title);
    if (campTitle) {
      return { included: true, reason: `camp/workshop opt-in: title matches /${campTitle}/` };
    }
    const campCategory = ev.categories.find((c) => anyMatch(CAMP_WORKSHOP_PATTERNS, c));
    if (campCategory) {
      return { included: true, reason: `camp/workshop opt-in: category "${campCategory}"` };
    }
  }
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
