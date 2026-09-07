/**
 * OPE-837 scope 6 — `robots.txt` parsing and a per-host rate limit.
 *
 * The submit@ crawl follows nav links on ONE domain that a submitter pointed
 * us at, capped at ~15 pages. That is bounded, but it is still the first thing
 * in this codebase that fetches a page nobody explicitly handed us, so it asks
 * permission the way a crawler is expected to.
 *
 * Deliberately small: group selection, `Allow`/`Disallow` with longest-match
 * precedence, `*` and `$` wildcards, and `Crawl-delay`. No sitemap handling,
 * no caching across submissions — a crawl is a handful of pages inside one
 * workflow, so a fetched `robots.txt` is used and discarded.
 *
 * Pure parsing; the fetch is the caller's.
 */

export interface RobotsRules {
  /** True when the path may be fetched. */
  isAllowed(pathWithQuery: string): boolean;
  /** Seconds between requests, from `Crawl-delay`. Null when unspecified. */
  crawlDelaySeconds: number | null;
  /** True when robots.txt named our agent explicitly rather than `*`. */
  matchedSpecificAgent: boolean;
}

interface Rule {
  allow: boolean;
  pattern: string;
}

/**
 * Everything is allowed.
 *
 * ⚠️ This is the response to a MISSING or UNREADABLE robots.txt, and that is
 * the correct reading: RFC 9309 §2.3.1.3 says a 4xx (including 404) means no
 * restrictions. It is NOT the response to a 5xx, which the caller should treat
 * as "do not crawl" — see `robotsUnavailableMeansStop`.
 */
export function allowAll(): RobotsRules {
  return { isAllowed: () => true, crawlDelaySeconds: null, matchedSpecificAgent: false };
}

/** Nothing is allowed. */
export function denyAll(): RobotsRules {
  return { isAllowed: () => false, crawlDelaySeconds: null, matchedSpecificAgent: false };
}

/**
 * Per RFC 9309 §2.3.1.4, a server error means the crawler should assume
 * disallow. Exposed as a named predicate so the call site reads as a decision
 * rather than a magic status comparison.
 */
export function robotsUnavailableMeansStop(status: number): boolean {
  return status >= 500;
}

/** The robots.txt URL for a page URL, or null if the URL is unusable. */
export function robotsUrlFor(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    return `${u.protocol}//${u.host}/robots.txt`;
  } catch {
    return null;
  }
}

/** Escape a robots path pattern into a RegExp, honouring `*` and `$`. */
function patternToRegExp(pattern: string): RegExp {
  let anchoredEnd = false;
  let p = pattern;
  if (p.endsWith("$")) {
    anchoredEnd = true;
    p = p.slice(0, -1);
  }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchoredEnd ? "$" : ""}`);
}

/**
 * Parse robots.txt for one user-agent.
 *
 * Group selection follows the spec: the most specific matching `User-agent`
 * group wins, falling back to `*`. Records with no group are ignored.
 */
export function parseRobots(content: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();

  // agentToken -> rules, plus crawl-delay per group.
  const groups = new Map<string, { rules: Rule[]; crawlDelay: number | null }>();
  let currentAgents: string[] = [];
  let inGroup = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "user-agent") {
      // A new user-agent line after directives starts a NEW group; consecutive
      // user-agent lines share one group.
      if (inGroup) {
        currentAgents = [];
        inGroup = false;
      }
      const token = value.toLowerCase();
      currentAgents.push(token);
      if (!groups.has(token)) groups.set(token, { rules: [], crawlDelay: null });
      continue;
    }

    if (currentAgents.length === 0) continue;
    inGroup = true;

    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "allow everything" and carries no pattern.
      if (field === "disallow" && value === "") {
        for (const a of currentAgents) groups.get(a)!.rules.push({ allow: true, pattern: "/" });
        continue;
      }
      if (value === "") continue;
      for (const a of currentAgents) {
        groups.get(a)!.rules.push({ allow: field === "allow", pattern: value });
      }
      continue;
    }

    if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        for (const a of currentAgents) groups.get(a)!.crawlDelay = n;
      }
    }
  }

  // Most specific matching agent token wins; `*` is the fallback.
  let chosen: { rules: Rule[]; crawlDelay: number | null } | undefined;
  let matchedSpecificAgent = false;
  let bestLen = -1;
  for (const [token, group] of groups) {
    if (token === "*") continue;
    if (ua.includes(token) && token.length > bestLen) {
      chosen = group;
      bestLen = token.length;
      matchedSpecificAgent = true;
    }
  }
  if (!chosen) chosen = groups.get("*");
  if (!chosen) return allowAll();

  const compiled = chosen.rules.map((r) => ({ ...r, re: patternToRegExp(r.pattern) }));

  return {
    crawlDelaySeconds: chosen.crawlDelay,
    matchedSpecificAgent,
    isAllowed(pathWithQuery: string): boolean {
      const path = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
      // Longest matching pattern wins; Allow beats Disallow at equal length
      // (RFC 9309 §2.2.2).
      let best: { allow: boolean; len: number } | null = null;
      for (const rule of compiled) {
        if (!rule.re.test(path)) continue;
        const len = rule.pattern.replace(/\$$/, "").length;
        if (!best || len > best.len || (len === best.len && rule.allow)) {
          best = { allow: rule.allow, len };
        }
      }
      return best ? best.allow : true;
    },
  };
}

/**
 * Minimum gap between requests to one host, in ms.
 *
 * Used when robots.txt names no `Crawl-delay`. One second is slower than a
 * browser loading a nav menu and fast enough that a 15-page cap stays inside
 * a Workflow step budget.
 */
export const DEFAULT_CRAWL_DELAY_MS = 1000;

/** Clamp a robots `Crawl-delay` into something a Workflow can actually wait. */
export function effectiveCrawlDelayMs(crawlDelaySeconds: number | null): number {
  if (crawlDelaySeconds === null) return DEFAULT_CRAWL_DELAY_MS;
  const ms = crawlDelaySeconds * 1000;
  // A site asking for 30s would blow the step budget; cap and proceed rather
  // than abandoning the crawl, since the cap is 15 pages on one small site.
  return Math.min(Math.max(ms, DEFAULT_CRAWL_DELAY_MS), 5000);
}
