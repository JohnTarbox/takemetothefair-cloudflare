/**
 * OPE-85 — the Tier-0 fault classifier. PURE, no I/O, never throws.
 *
 * ── What Tier-0 is ────────────────────────────────────────────────────────────
 * At candidate emission (OPE-81's /faults/candidates) each emitted fault carries a
 * stable signature (`route#errorClass`, see signature.ts). BEFORE the Tier-1 analyst
 * scan sees it, we match the NORMALIZED error class against an in-repo bug-family
 * registry: a known fault shape arrives PRE-DIAGNOSED (root-cause class + fix pattern
 * + guard status) so the analyst can fast-path it. An unknown shape is tagged
 * `unclassified` and falls through to full Tier-1 RCA.
 *
 * ── What the matcher runs on ──────────────────────────────────────────────────
 * The SAME normalized surface signature.ts produces — `normalizeErrorClass` has
 * already lowercased, whitespace-collapsed, and stripped volatile tokens (request
 * ids, offsets, quoted literals). So matchers are lowercase substrings / RegExps
 * tested against that stable class (e.g. `too many sql variables`). We still
 * lower-case defensively here in case a raw (un-normalized) class is passed.
 *
 * ── Precedence ────────────────────────────────────────────────────────────────
 * FAULT_FAMILIES is precedence-ordered, MOST SPECIFIC FIRST. classifyFault walks it
 * in order and the FIRST family whose matchers hit wins (first-match-wins) — so a
 * message carrying both a param-cap token and a generic token resolves to param-cap.
 *
 * This module is deterministic and side-effect free.
 */

/** A guard's disposition for a family: is the code-level guard in place? */
export type GuardStatus = "present" | "missing" | "partial" | "n/a";

/**
 * A single matcher against the normalized error class. A lowercase substring
 * (matched with `.includes`) or a RegExp (matched with `.test`). RegExps should be
 * authored case-insensitively / against the lowercased class.
 */
export type FaultMatcher = string | RegExp;

/** One bug family in the Tier-0 registry. */
export interface FaultFamily {
  /** Stable machine key (e.g. "FAM-D1-PARAMCAP"). */
  key: string;
  /** Human-readable title. */
  title: string;
  /**
   * Substrings / RegExps tested against the normalized error class. A family
   * matches when ANY matcher hits (and the optional `route` predicate, if present,
   * also passes).
   */
  matchers: FaultMatcher[];
  /** Optional route gate — narrows a family to a route context. */
  route?: (route: string | null | undefined) => boolean;
  /** The diagnosed root-cause class. */
  rootCauseClass: string;
  /** The known fix pattern for this family. */
  fixPattern: string;
  /** Whether the code-level guard against this family is in place. */
  guardStatus: GuardStatus;
  /** Optional pointer to the guard (script / file) that enforces the fix. */
  guardRef?: string;
}

/**
 * The Tier-0 result. Either an auto-classification (a family matched) or an
 * explicit `unclassified` marker (no family matched → full Tier-1 RCA).
 */
export type FaultClassification =
  | {
      disposition: "auto-classified";
      familyKey: string;
      rootCauseClass: string;
      fixPattern: string;
      guardStatus: GuardStatus;
      guardRef?: string;
    }
  | { disposition: "unclassified" };

/**
 * The bug-family registry — precedence-ordered, MOST SPECIFIC FIRST, first-match-
 * wins. Encoded from OPE-82's Bug-Family-Registry deliverable + codebase history.
 * Matchers run against the normalized error class (see normalizeErrorClass).
 */
export const FAULT_FAMILIES: readonly FaultFamily[] = [
  {
    // THE acceptance example: D1's 100-bound-parameter cap (SQLITE_MAX_VARIABLE_NUMBER).
    key: "FAM-D1-PARAMCAP",
    title: "D1 bound-parameter cap exceeded",
    matchers: ["too many sql variables", "too many bound parameters"],
    rootCauseClass: "param-cap",
    fixPattern: "chunk ≤90",
    guardStatus: "missing",
  },
  {
    // D1's per-row column cap — distinct from the parameter cap.
    key: "FAM-D1-COLCAP",
    title: "D1 column cap exceeded",
    matchers: ["too many columns", "max columns per row"],
    rootCauseClass: "column-cap",
    fixPattern: "narrow projection / batched hydration (≤100 cols)",
    guardStatus: "present",
    guardRef: "check-d1-100col-joins.ts",
  },
  {
    // JSON-LD emitted with a null/undefined required Event field — the parent-
    // derivation discipline (derive from event_days/series children).
    key: "FAM-JSONLD-PARENTDERIV",
    title: "JSON-LD required field null (parent derivation)",
    matchers: [
      /json-?ld.*(null|undefined)/,
      /(null|undefined).*json-?ld/,
      /(startdate|location).*undefined/,
      /undefined.*(startdate|location)/,
    ],
    rootCauseClass: "jsonld-parent-derivation",
    fixPattern: "derive required Event fields from event_days/series children",
    guardStatus: "partial",
  },
  {
    // Render throws off an empty/undefined collection (map/reduce/spread/access).
    key: "FAM-EMPTY-COLLECTION",
    title: "Empty-collection render throw",
    // NOTE: matchers kept specific to empty/undefined-COLLECTION access. A bare
    // "is not a function" is deliberately excluded — it's a generic TypeError, not
    // reliably an empty-collection shape, and a wrong Tier-0 tag misleads the
    // analyst auto-file. Reconcile against OPE-82's registry doc.
    matchers: [
      "cannot read properties of undefined (reading",
      "cannot read property",
      "reduce of empty array",
      "undefined is not iterable",
    ],
    rootCauseClass: "empty-collection-render",
    fixPattern: "guard empty/undefined collection before access/render",
    guardStatus: "missing",
  },
  {
    // Stale-deploy chunk churn. OPE-81's isNoise already denylists these upstream so
    // they rarely reach the classifier — the family exists so the disposition is
    // explicit (client noise, not a code fix) when one slips through.
    key: "FAM-CHUNK-STALE",
    title: "Stale-deploy chunk load failure",
    matchers: ["loading chunk", "chunkloaderror", "failed to fetch dynamically imported module"],
    rootCauseClass: "stale-deploy-chunk",
    fixPattern: "client noise — denylist, not a code fix",
    guardStatus: "n/a",
  },
  {
    // A known-external upstream deferral (OPE-73 shape) — a 502/bad-gateway from a
    // dependency treated as not-a-failure, not a bug in our code.
    key: "FAM-EXTERNAL-DEFERRAL",
    title: "External upstream deferral",
    // No bare "502": normalizeErrorClass strips standalone numbers, so it never
    // survives on the classifier's input, and as a raw substring it false-matches
    // any id containing "502". Match on the durable phrase tokens instead.
    matchers: ["bad gateway", "upstream", "deferred"],
    rootCauseClass: "external-deferral",
    fixPattern: "treat deferral as not-a-failure (circuit-breaker/kill-switch aware)",
    guardStatus: "n/a",
  },
] as const;

/** True when a single matcher hits the (already lowercased) error class. */
function matcherHits(matcher: FaultMatcher, errorClass: string): boolean {
  if (typeof matcher === "string") return errorClass.includes(matcher);
  try {
    return matcher.test(errorClass);
  } catch {
    // A pathological RegExp must never abort classification.
    return false;
  }
}

/**
 * Classify a fault by its normalized error class (+ optional route). PURE, never
 * throws. Walks FAULT_FAMILIES in precedence order and returns the FIRST family
 * whose matchers (and optional route predicate) hit — first-match-wins. Case-
 * insensitive; empty/nullish error class → `unclassified`.
 */
export function classifyFault(input: {
  errorClass: string | null | undefined;
  route?: string | null;
}): FaultClassification {
  const errorClass =
    typeof input.errorClass === "string" ? input.errorClass.toLowerCase().trim() : "";
  if (!errorClass) return { disposition: "unclassified" };
  const route = input.route ?? null;

  for (const family of FAULT_FAMILIES) {
    if (family.route && !family.route(route)) continue;
    if (family.matchers.some((m) => matcherHits(m, errorClass))) {
      return {
        disposition: "auto-classified",
        familyKey: family.key,
        rootCauseClass: family.rootCauseClass,
        fixPattern: family.fixPattern,
        guardStatus: family.guardStatus,
        ...(family.guardRef ? { guardRef: family.guardRef } : {}),
      };
    }
  }
  return { disposition: "unclassified" };
}

/**
 * Classify a full emitted signature (`route#errorClass`, see computeSignature).
 * Splits on the FIRST `#` to recover route + error class and delegates to
 * classifyFault. PURE, never throws; a signature with no `#` classifies on the
 * whole string as the error class (route unknown).
 */
export function classifySignature(signature: string | null | undefined): FaultClassification {
  if (typeof signature !== "string" || !signature) return { disposition: "unclassified" };
  const hash = signature.indexOf("#");
  const route = hash >= 0 ? signature.slice(0, hash) : null;
  const errorClass = hash >= 0 ? signature.slice(hash + 1) : signature;
  return classifyFault({ errorClass, route });
}
