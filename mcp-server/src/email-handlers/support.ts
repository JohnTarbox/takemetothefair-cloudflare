/**
 * `support@` / `hello@` handler — general questions and contact-form
 * replacement. No DB writes; the entrypoint already forwarded the
 * original message to the admin Gmail. Sender gets a friendly auto-ack.
 */

import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (_env, _ctx, row): Promise<HandlerResult> => {
  return {
    replyKind: "support-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
  };
};
