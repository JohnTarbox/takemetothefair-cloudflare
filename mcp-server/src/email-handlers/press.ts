/**
 * `press@` handler — media inquiries. The entrypoint already forwarded
 * the original to the admin Gmail. Sender gets a generic ack — no
 * media-kit URL committed yet (deferred until a /press page exists).
 *
 * If/when we add a media kit, expand the reply template in
 * email-reply-builder.ts to include the URL conditionally.
 */

import type { HandlerFn, HandlerResult } from "./types.js";

export const handle: HandlerFn = async (_env, _ctx, row): Promise<HandlerResult> => {
  return {
    replyKind: "press-ack",
    replyParams: { subject: row.subject ?? "" },
    status: "replied",
  };
};
