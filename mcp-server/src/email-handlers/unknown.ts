/**
 * Catch-all handler for any recipient address not matched by
 * email-intents.ts's INTENT_MAP. The entrypoint forwarded the original
 * to admin Gmail before workflow creation, so the admin has full
 * context. Sender gets nothing back — silent on purpose (prevents
 * reflective-spam vector if attackers email random@meetmeatthefair).
 *
 * Returns replyKind: null so the workflow's send-reply step skips
 * entirely.
 */

import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (): Promise<HandlerResult> => {
  return {
    replyKind: null,
    status: "forwarded",
  };
};
