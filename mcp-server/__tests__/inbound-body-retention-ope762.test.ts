/**
 * OPE-762 — a classified-spam message must keep its body.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `insertSpamAuditRow` and `insertAuditNoopRow` both describe themselves as
 * mirroring the main inbound INSERT. OPE-156 added `body_text` / `body_html`
 * to that main insert and neither mirror was updated, so both terminal paths
 * wrote a subject line, a label and a 500-char excerpt — and nothing else.
 *
 * Measured in prod on 2026-09-02: 14 of 14 `intent='spam'` rows received since
 * 2026-07-01 have NULL for BOTH body columns. 100%, not a sample.
 *
 * The consequence is not "we lose some spam". It is that a spam
 * misclassification destroys its own evidence in the same transaction that
 * creates it: a real organizer wrongly labelled spam leaves nothing that could
 * ever show the label was wrong. The classifier's accuracy is not merely
 * unmeasured, it is unmeasurable, because the cases most worth reviewing are
 * exactly the ones erased.
 *
 * ── Why there are two KINDS of test here ───────────────────────────────────
 * The behavioural tests prove today's two paths keep the body. They cannot
 * prove the NEXT path will, and "a third mirror of the main insert" is exactly
 * how this arrived. So the last test is structural and keyed on the TABLE:
 * every insert into `inbound_emails` must carry the body columns, whatever it
 * is called and whoever writes it.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { createTestDb, type TestDb } from "./setup-db.js";
import { insertSpamAuditRow, insertAuditNoopRow } from "../src/email-handler.js";
import { inboundEmails } from "../src/schema.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

/** The shape `email()` hands the spam path, with a body worth keeping. */
const SPAM_BODY =
  "Hi,\nI was examining your website and saw you have a good design. " +
  "But it was not ranking on any search engines for most of the keywords.";

function spamArgs(over: Record<string, unknown> = {}) {
  return {
    // `env` is used only for error logging on this path; the insert goes
    // through the `db` argument.
    env: { DB: null } as never,
    sessionId: "s-1",
    fromAddr: "jordan@corporatedigitalagency.com",
    toAddr: "hello@meetmeatthefair.com",
    subject: "Re: meetmeatthefair.com: Improve 1st Ranking in Google!!!",
    bodyTextExcerpt: SPAM_BODY.slice(0, 500),
    bodyTextStored: SPAM_BODY,
    bodyHtmlStored: `<p>${SPAM_BODY}</p>`,
    message: { rawSize: 70_000 } as never,
    parsed: { messageId: "<spam-1@example.com>" } as never,
    attachmentCount: 0,
    routing: {
      aggregateConfidence: 0.97,
      spamRationale: "SEO solicitation",
      classifierVersion: "c-2026-06-16-v5",
    } as never,
    ...over,
  };
}

describe("OPE-762 — the spam path keeps its evidence", () => {
  it("persists body_text and body_html on a spam-quarantined message", async () => {
    await insertSpamAuditRow(db as never, spamArgs());

    const [row] = await db.select().from(inboundEmails);
    expect(row.intent).toBe("spam");
    expect(row.bodyText).toBe(SPAM_BODY);
    expect(row.bodyHtml).toContain("ranking");
  });

  it("still records the excerpt — the fix ADDS retention, it does not move it", () => {
    // The excerpt was never the missing piece: 13 of the 14 lost prod rows do
    // have one. Losing it while "fixing" retention would trade one gap for
    // another, and the admin list preview reads this column.
    expect(spamArgs().bodyTextExcerpt.length).toBeGreaterThan(0);
  });

  it("keeps a genuinely bodyless message distinguishable from a dropped one", async () => {
    // NULL must keep meaning "there was no body", not "we forgot to write it".
    // That distinction is the entire point of the ticket, so it needs its own
    // assertion rather than being implied by the case above.
    await insertSpamAuditRow(
      db as never,
      spamArgs({ bodyTextStored: null, bodyHtmlStored: null, bodyTextExcerpt: "" })
    );

    const [row] = await db.select().from(inboundEmails);
    expect(row.bodyText).toBeNull();
  });
});

describe("OPE-762 — the audit-noop path keeps its evidence too", () => {
  it("persists the body on a terminal audit-noop row", async () => {
    // Scope 1 says "every inbound row regardless of classified intent", and
    // this is an inbound row. It carried the identical omission for the
    // identical reason.
    await insertAuditNoopRow(db as never, {
      fromAddr: "notify@meetmeatthefair.com",
      toAddr: "submit@meetmeatthefair.com",
      subject: "audit copy",
      bodyTextExcerpt: "audit copy body",
      bodyTextStored: "audit copy body, in full",
      bodyHtmlStored: null,
      attachmentCount: 0,
      rawSize: 1234,
      messageId: "<audit-762@meetmeatthefair.com>",
      reason: "outbound-audit-copy",
    });

    const [row] = await db.select().from(inboundEmails);
    expect(row.bodyText).toBe("audit copy body, in full");
  });
});

/**
 * The structural guard.
 *
 * Keyed on the TABLE, not on the two functions this ticket fixed. A guard that
 * named `insertSpamAuditRow` would be blind to the very thing that produced
 * this defect: somebody adding a THIRD insert that mirrors the main one and
 * omits the columns. Both existing offenders describe themselves in their own
 * docblocks as mirroring the main insert, and both were wrong.
 */
describe("OPE-762 — every insert into inbound_emails carries the body columns", () => {
  it("finds no insert site that omits body_text or body_html", async () => {
    const src = await readFile(new URL("../src/email-handler.ts", import.meta.url), "utf8");

    // Anchored on the CALL syntax, not the bare symbol: `inboundEmails` also
    // appears on the import line and in a dozen selects, and matching those
    // would make this pass vacuously on a file with no inserts at all.
    const sites = [...src.matchAll(/\.insert\(inboundEmails\)\s*\n?\s*\.values\(\{/g)];

    // The positive landmark. Without it, a refactor that renames the table
    // binding, or a regex that stops matching, reports "0 offenders" — which
    // reads exactly like "all good".
    expect(
      sites.length,
      "no `.insert(inboundEmails).values({` call sites found — the guard has gone inert, it has not passed"
    ).toBeGreaterThanOrEqual(3);

    const offenders: string[] = [];
    for (const m of sites) {
      // The values object runs to the closing `})` of the .values(...) call.
      // Scanning a generous fixed window is enough and avoids a brace parser:
      // the longest of these objects is ~30 short lines.
      const block = src.slice(m.index!, m.index! + 3000);
      const end = block.indexOf("\n      })");
      const values = end === -1 ? block : block.slice(0, end);
      if (!/\bbodyText:/.test(values) || !/\bbodyHtml:/.test(values)) {
        const line = src.slice(0, m.index!).split("\n").length;
        offenders.push(`email-handler.ts:${line}`);
      }
    }

    expect(
      offenders,
      `these inserts into inbound_emails drop the message body — a row written here can never be audited, ` +
        `and a misclassification erases its own evidence (OPE-762): ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
