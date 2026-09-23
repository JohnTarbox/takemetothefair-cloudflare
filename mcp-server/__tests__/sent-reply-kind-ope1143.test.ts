/**
 * OPE-1143 — inbound_emails.reply_kind must record the kind actually SENT.
 *
 * The send-reply guards swap the template inside the step (thread-reply-ack
 * for a reply on our own thread, unfetchable-url for a no-url with a link),
 * but mark-done wrote the PRE-swap result.replyKind. Prod: 6 rows since 09-04
 * stored `correction-ack` while the ledger says `reply:thread-reply-ack`.
 *
 * Source-level, like owed-human-ope1018's wiring tests: the property is an
 * ordering + a data flow inside a Workflow, and a reassigned local would also
 * be lost on replay — only a step's RETURN value is cached.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/workflows/inbound-email.ts", import.meta.url), "utf8");

describe("the sent kind reaches mark-done", () => {
  it("send-reply returns the post-swap replyKind", () => {
    const a = src.indexOf("const sentKind = await step.do(");
    const step = src.slice(a, src.indexOf('if (typeof sentKind === "string"', a));
    expect(step).toMatch(/source: `reply:\$\{replyKind\}`[\s\S]*return replyKind;/);
  });

  it("result takes the sent kind before mark-done writes it", () => {
    const update = src.indexOf("result = { ...result, replyKind: sentKind };");
    expect(update).toBeGreaterThan(src.indexOf("const sentKind = await step.do("));
    expect(update).toBeLessThan(src.indexOf('"mark-done"', update));
  });
});
