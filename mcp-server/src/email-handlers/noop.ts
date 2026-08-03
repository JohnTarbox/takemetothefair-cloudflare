/**
 * OPE-317 — handler for intents already fully resolved at the entrypoint.
 *
 * `newsletter_subscribe` is the first: by the time the workflow runs, the
 * sender has their confirmation email and there is nothing left to do.
 *
 * It exists so the exhaustive HANDLERS map can say "nothing happens here"
 * explicitly. Mapping it to handleUnknown instead would send someone who just
 * signed up a "we couldn't understand your message" reply — the exact wrong
 * answer, and the kind of thing a default case hides.
 */
import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (): Promise<HandlerResult> => ({
  // No reply: the sender already has their confirmation email.
  replyKind: null,
  // "forwarded" rather than "replied" — FinalStatus has no "nothing to do"
  // value, and claiming we replied when we didn't would make the inbound
  // viewer lie about what the sender received.
  status: "forwarded",
});
