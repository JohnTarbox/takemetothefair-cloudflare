/**
 * OPE-1615 — a classifier timeout is "we don't know yet", not a verdict.
 *
 * John's ruling (2026-11-10, answering OPE-1609 decision 2): neither "ack
 * anyway" nor "stay silent" — retry the classification later. Before this, a
 * timeout stored `classified_intent='unclear'` at confidence 0, routed by
 * ADDRESS, and the OPE-1148 zero-confidence guard then withheld the ack. Sammi
 * (`7f761f2a`) got silence that way, and was sent down `support` when a working
 * classifier would have sent her to onboarding.
 *
 * Shape of the fix, split across three places that each own one fact:
 *
 *  - The ENTRYPOINT decides to defer (`shouldDeferClassification`): it stores
 *    the row as `status='classifying'`, `reply_kind='classify-retry:0'`, with
 *    no classified intent, and starts the workflow with the classifier inputs.
 *  - The WORKFLOW sleeps on `CLASSIFY_RETRY_DELAYS_SEC` and re-classifies
 *    (`routeRetriedClassification`), before mark-processing and before any
 *    dispatch, so no lane, ack, obligation or event exists until a real
 *    verdict does. One workflow instance, one dispatch: a retry can never cause
 *    a second send, because a send only happens after the loop has ended.
 *  - The STALE SWEEP extends its `processing` threshold by
 *    `CLASSIFY_RETRY_WINDOW_SEC` for these rows, so a row resuming 42 minutes
 *    after it arrived is not mistaken for a stalled one and re-run.
 *
 * If every attempt fails the workflow runs the solicitation screen on its own
 * and either sends the neutral support-ack wording as
 * `ack-after-classifier-failure` (with an obligation) or records the message as
 * screened out. Either way it writes a `classifier-unavailable:` error, which the
 * FAM-CLASSIFIER-UNAVAILABLE fault family picks up for CPI.
 */

import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  shouldQuarantineAsSpam,
  type ClassifierInput,
  type ClassifierResult,
} from "../intent-classifier.js";
import { isListBrokerSolicitation } from "../email-handlers/solicitation-screen.js";
import type { EmailIntent } from "../email-intents.js";

/** Rationale prefix `classifyIntent` writes when the model never answered. */
export const CLASSIFIER_ERROR_PREFIX = "classifier-error:";

/**
 * Sleep before each retry attempt, in seconds. Attempts land at about +2, +10
 * and +30 minutes after the email arrived (120, 120+480, 120+480+1200).
 * Measured basis (OPE-1089): ~10% of inbound times out, never below 5.8% in a
 * month, and timeouts are isolated rather than clustered, so a short first
 * wait should recover most of them.
 */
export const CLASSIFY_RETRY_DELAYS_SEC: readonly number[] = [120, 480, 1200];

/** Total time spent waiting across all retries (30 minutes). */
export const CLASSIFY_RETRY_WINDOW_SEC = CLASSIFY_RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);

/** `reply_kind` while a row waits for a verdict: `classify-retry:<attempts so far>`. */
export const CLASSIFY_RETRY_REPLY_KIND_PREFIX = "classify-retry:";

/** Row status while a verdict is pending. Never `replied`, never `processing`. */
export const CLASSIFYING_STATUS = "classifying";

/** `reply_kind` of the neutral ack sent after every retry failed. */
export const ACK_AFTER_CLASSIFIER_FAILURE = "ack-after-classifier-failure" as const;

/** `reply_kind` recorded when the fallback's solicitation screen caught it. */
export const SCREENED_AFTER_CLASSIFIER_FAILURE = "screened-after-classifier-failure";

/** Message prefix of the fault row; FAM-CLASSIFIER-UNAVAILABLE matches it. */
export const CLASSIFIER_UNAVAILABLE_FAULT = "classifier-unavailable:";

export function classifyRetryReplyKind(attemptsSoFar: number): string {
  return `${CLASSIFY_RETRY_REPLY_KIND_PREFIX}${attemptsSoFar}`;
}

/** True when this rationale says the classifier never answered (timeout, transport). */
export function isClassifierErrorRationale(rationale: string | null | undefined): boolean {
  return typeof rationale === "string" && rationale.startsWith(CLASSIFIER_ERROR_PREFIX);
}

/**
 * Should the entrypoint defer this message instead of routing it now?
 *
 * Only when the classifier ran and ERRORED: not when it was skipped (trusted
 * fast-path, no AI binding, address-bound lanes), and not when it answered at
 * low confidence. A screened solicitation never reaches here — `classifyIntent`
 * returns a spam verdict for it, which the quarantine handles first.
 */
export function shouldDeferClassification(routing: {
  routingSource: string;
  aggregateRationale: string | null;
  routed: readonly unknown[];
  spamQuarantine: boolean;
}): boolean {
  return (
    !routing.spamQuarantine &&
    routing.routingSource === "address_only" &&
    routing.routed.length === 1 &&
    isClassifierErrorRationale(routing.aggregateRationale)
  );
}

/** What a retried classification decides. */
export type RetriedRoute =
  | { kind: "error" }
  | {
      kind: "routed";
      intent: EmailIntent;
      classifiedIntent: string;
      classifiedSubIntent: string | null;
      confidence: number;
      rationale: string;
      routingSource: string;
      flaggedForReview: boolean;
      /** Set when the classifier saw several intents; the retry dispatches one. */
      multiIntentCollapsed: boolean;
    };

/**
 * Turn a retried classifier result into a route, mirroring the entrypoint's
 * `computeRouting` single-intent rules. One deliberate difference: a
 * multi-intent verdict is NOT fanned out into child rows — the row already
 * exists and has one workflow — so the strongest child is dispatched and the
 * row is flagged for review, saying so in its rationale.
 */
export function routeRetriedClassification(
  result: ClassifierResult,
  addressIntent: EmailIntent
): RetriedRoute {
  const top = result.intents[0];
  if (!result.fromAi || !top || isClassifierErrorRationale(top.rationale)) {
    return { kind: "error" };
  }
  if (shouldQuarantineAsSpam(result)) {
    return {
      kind: "routed",
      intent: "spam",
      classifiedIntent: top.intent,
      classifiedSubIntent: top.subIntent,
      confidence: top.confidence,
      rationale: top.rationale,
      routingSource: "classifier_retry",
      flaggedForReview: false,
      multiIntentCollapsed: false,
    };
  }
  const confident = result.intents.filter((c) => c.confidence >= DEFAULT_CONFIDENCE_THRESHOLD);
  if (confident.length >= 1) {
    const best = confident.reduce((a, b) => (b.confidence > a.confidence ? b : a), confident[0]);
    const collapsed = confident.length >= 2;
    return {
      kind: "routed",
      intent: best.intent as EmailIntent,
      classifiedIntent: best.intent,
      classifiedSubIntent: best.subIntent,
      confidence: best.confidence,
      rationale: collapsed
        ? `${best.rationale} [retry: multi-intent (${confident.length}) collapsed to strongest]`
        : best.rationale,
      routingSource: "classifier_retry",
      flaggedForReview: collapsed,
      multiIntentCollapsed: collapsed,
    };
  }
  // The classifier answered, below threshold: the entrypoint's
  // fallback_low_confidence rule. The OPE-1148 guard applies normally here,
  // because this classifier DID run.
  return {
    kind: "routed",
    intent: addressIntent,
    classifiedIntent: top.intent,
    classifiedSubIntent: top.subIntent,
    confidence: top.confidence,
    rationale: top.rationale,
    routingSource: "fallback_low_confidence",
    flaggedForReview: true,
    multiIntentCollapsed: false,
  };
}

/** The final fallback's screen: true when the message should get no reply at all. */
export function fallbackScreensOut(input: Pick<ClassifierInput, "subject" | "bodyText">): boolean {
  return isListBrokerSolicitation(input.subject, input.bodyText);
}

/** The classifier inputs the entrypoint carries to the workflow (body is read from the row). */
export type ClassifyRetryParams = Omit<ClassifierInput, "subject" | "bodyText"> & {
  addressIntent: EmailIntent;
};

/** The outcome of the whole retry loop. */
export type ClassifyRetryOutcome =
  | { outcome: "recovered"; attempt: number; route: Extract<RetriedRoute, { kind: "routed" }> }
  | { outcome: "exhausted"; attempts: number };

/**
 * Run the retry loop. Injected `sleep` and `classify` so the workflow can back
 * them with `step.sleep` / `step.do` (cached across replays) and a test can
 * drive them directly. `onAttempt` records `classify-retry:<n>` on the row.
 */
export async function runClassifyRetries(deps: {
  addressIntent: EmailIntent;
  sleep: (attempt: number, seconds: number) => Promise<void>;
  classify: (attempt: number) => Promise<ClassifierResult>;
  onAttempt?: (attempt: number, route: RetriedRoute) => Promise<void>;
}): Promise<ClassifyRetryOutcome> {
  for (let i = 0; i < CLASSIFY_RETRY_DELAYS_SEC.length; i++) {
    const attempt = i + 1;
    await deps.sleep(attempt, CLASSIFY_RETRY_DELAYS_SEC[i]);
    const route = routeRetriedClassification(await deps.classify(attempt), deps.addressIntent);
    if (deps.onAttempt) await deps.onAttempt(attempt, route);
    if (route.kind === "routed") return { outcome: "recovered", attempt, route };
  }
  return { outcome: "exhausted", attempts: CLASSIFY_RETRY_DELAYS_SEC.length };
}
