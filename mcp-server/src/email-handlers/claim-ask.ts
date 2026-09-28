/**
 * OPE-1214 — a reply to one of OUR messages quotes our text; the classifier
 * must read only what the sender wrote.
 *
 * The specimen: an organizer answered our automated "your event was featured"
 * notice with a schedule correction. The classifier read the whole body,
 * including our quoted notice ("your event", "visit your event page", our own
 * event URL), and split the message into `correction` + `claim_request`. The
 * ack then told him "we also read it as a request to claim a listing". Nothing
 * he wrote asked for that.
 */
import { stripQuotedReply } from "./strip-quoted-reply.js";

/** Below this many characters the sender bottom-posted; keep everything. */
const MIN_REMAINDER = 20;

/**
 * The sender's own text of a reply to our thread: the reply-attribution cut
 * (`stripQuotedReply`, forward-safe) plus any `>`-quoted lines it left behind.
 * Returns the input unchanged when cutting would leave essentially nothing.
 */
export function senderTextOfReply(bodyText: string): string {
  if (!bodyText) return bodyText;
  const cut = stripQuotedReply(bodyText);
  const unquoted = cut
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
  return unquoted.length >= MIN_REMAINDER ? unquoted : bodyText;
}

/**
 * An explicit ask to claim or control a listing, in the sender's own words.
 *
 * Deliberately a floor, not a classifier: it can only REMOVE a `claim_request`
 * the model inferred from context, never add one. Words from the ticket's list
 * (claim / manage / take over / verify / log in), each tied to the listing or
 * the account so that prose like "we manage parking" does not count.
 */
const CLAIM_ASK =
  /\b(claim(?:ing|ed)?\b|take over\b|(?:manage|verify|update|edit|control)\s+(?:the |our |my |this )?(?:listing|page|profile|account)|log ?(?:in|into)\b|sign ?in\b|access to (?:the |our |my )?(?:listing|page|account))/i;

export function hasExplicitClaimAsk(senderText: string): boolean {
  return CLAIM_ASK.test(senderText);
}

/**
 * Drop a `claim_request` that rides alongside another intent without an
 * explicit ask in the sender's own text. Only a SIBLING is dropped: a message
 * whose sole reading is a claim is left to the model. Returns the input array
 * itself when nothing changes.
 */
export function dropInferredClaimSibling<T extends { intent: string }>(
  intents: T[],
  senderText: string
): { intents: T[]; dropped: boolean } {
  const inferred =
    intents.length >= 2 &&
    intents.some((c) => c.intent === "claim_request") &&
    !hasExplicitClaimAsk(senderText);
  return inferred
    ? { intents: intents.filter((c) => c.intent !== "claim_request"), dropped: true }
    : { intents, dropped: false };
}
