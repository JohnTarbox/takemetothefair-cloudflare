/**
 * OPE-768 scopes 2–5 — the review bounce of 2026-09-23.
 *
 * The first pass shipped the thread key (scope 1). Returned because: 483
 * pre-threading rows NULL, the queue still counted envelopes, an operator
 * forward still minted a second obligation, and there was no whole-thread read.
 *
 * Fixtures are the real rows (prod `inbound_emails` / `email_send_ledger`,
 * read 2026-09-23), ids and Message-IDs verbatim where they matter.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { correspondentKey, resolveThread } from "@takemetothefair/utils";
import * as schema from "../src/schema.js";
import {
  adminActions,
  emailSendLedger,
  inboundEmails,
  inboundEmailSenders,
  supportObligations,
} from "../src/schema.js";
import { planThreadBackfill, type BackfillInboundRow } from "../src/inbound/thread-backfill.js";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    const unique = (c as unknown as { isUnique?: boolean }).isUnique ? " UNIQUE" : "";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}${unique}`;
  });
  const indexes = cfg.indexes.map((idx) => {
    const x = (
      idx as unknown as { config: { name: string; unique: boolean; columns: { name: string }[] } }
    ).config;
    return `CREATE ${x.unique ? "UNIQUE " : ""}INDEX ${x.name} ON ${cfg.name} (${x.columns
      .map((c) => c.name)
      .join(", ")});`;
  });
  return [`CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`, ...indexes].join("\n");
}

const harness = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn() }));
vi.mock("../src/tools/admin-send-vendor-email.js", () => ({
  isEmailSuppressed: async () => false,
}));

const { openObligationIfOwed } = await import("../src/email-handlers/open-obligation.js");
const { registerEmailThreadTools } = await import("../src/tools/admin-email-threads.js");
const { registerSupportObligationTools } =
  await import("../src/tools/admin-support-obligations.js");
const { storedMessageIdForms, resolveThreadColumns } = await import("../src/email-handler.js");

let db: any;
beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  harness.db = drizzle(raw, { schema });
  // D1's batch, sequentially — better-sqlite3's drizzle has none.
  harness.db.batch = async (stmts: unknown[]) => {
    for (const s of stmts) await s;
  };
  db = harness.db;
});

function tools() {
  const map = new Map<string, (args: any) => Promise<any>>();
  const server = { tool: (name: string, _d: unknown, _s: unknown, h: any) => map.set(name, h) };
  const auth = { userId: "admin-1", role: "ADMIN" as const };
  registerEmailThreadTools(server as never, db, auth);
  registerSupportObligationTools(server as never, db, auth);
  return map;
}
const json = (res: any) => JSON.parse(res.content[0].text);

let clock = Date.UTC(2026, 6, 1);
async function inbound(over: Record<string, unknown>) {
  clock += 60_000;
  await db.insert(inboundEmails).values({
    sessionId: `s-${over.id}`,
    toAddress: "support@meetmeatthefair.com",
    intent: "support",
    classifiedIntent: "support",
    classifiedConfidence: 0.9,
    receivedAt: new Date(clock),
    createdAt: new Date(clock),
    status: "received",
    ...over,
  } as never);
  return db
    .select()
    .from(inboundEmails)
    .all()
    .find((r: any) => r.id === over.id);
}

// ─────────────────────────────────────────────────────────────────────────
describe("scope 2 — one waiting obligation per conversation", () => {
  it("a second message on a thread with an OPEN obligation joins it; no second row", async () => {
    const a = await inbound({ id: "a1", fromAddress: "p@x.test", threadId: "T1" });
    const b = await inbound({ id: "a2", fromAddress: "p@x.test", threadId: "T1" });
    const ra = await openObligationIfOwed({ DB: {} as never }, db, a, "t");
    const rb = await openObligationIfOwed({ DB: {} as never }, db, b, "t");
    expect(rb).toBe(ra);
    expect(db.select().from(supportObligations).all()).toHaveLength(1);
  });

  it("after the obligation is answered, a new message on the thread IS owed a new answer", async () => {
    const a = await inbound({ id: "b1", fromAddress: "p@x.test", threadId: "T2" });
    await openObligationIfOwed({ DB: {} as never }, db, a, "t");
    await db.update(supportObligations).set({ status: "answered" });
    const b = await inbound({ id: "b2", fromAddress: "p@x.test", threadId: "T2" });
    await openObligationIfOwed({ DB: {} as never }, db, b, "t");
    expect(db.select().from(supportObligations).all()).toHaveLength(2);
  });

  it("threads stay strict: one person, two conversations → two obligations, ONE person waiting", async () => {
    // Heather Santiago, 2026-07-11: "account" → support@, "booth set up" → hello@.
    const a = await inbound({
      id: "ade34b9e",
      fromAddress: "heathersantiago@furbabymedical.com",
      subject: "account",
      threadId: "TH-a",
    });
    const b = await inbound({
      id: "428f8546",
      fromAddress: "heathersantiago@furbabymedical.com",
      toAddress: "hello@meetmeatthefair.com",
      subject: "booth set up",
      threadId: "TH-b",
    });
    await openObligationIfOwed({ DB: {} as never }, db, a, "t");
    await openObligationIfOwed({ DB: {} as never }, db, b, "t");
    const out = json(await tools().get("list_support_obligations")!({ status: "open", limit: 50 }));
    expect(out.waiting).toMatchObject({
      people_waiting: 1,
      conversations_waiting: 2,
      open_rows: 2,
    });
    expect(new Set(out.obligations.map((o: any) => o.correspondent))).toEqual(
      new Set(["heathersantiago@furbabymedical.com"])
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("scope 3 — an operator forward opens no obligation", () => {
  it("a row threaded as operator_forward returns null and writes nothing", async () => {
    const f = await inbound({
      id: "fwd1",
      fromAddress: "jtarboxme@gmail.com",
      subject: "Fwd: Account creation",
      threadId: "TC",
      threadBasis: "operator_forward",
      originalSenderAddress: "celina.daigle@freedomboatclub.us",
    });
    expect(await openObligationIfOwed({ DB: {} as never }, db, f, "t")).toBeNull();
    expect(db.select().from(supportObligations).all()).toHaveLength(0);
  });

  it("the resolver joins a trusted forward to the customer's thread on sender + subject", () => {
    const candidates = [
      {
        threadId: "TC",
        messageId: "<a@x>",
        normalizedSubject: "account creation",
        participants: "celina.daigle@freedomboatclub.us|support@meetmeatthefair.com",
        fromAddress: "celina.daigle@freedomboatclub.us",
      },
    ];
    const base = {
      subject: "Fwd: Account creation",
      participants: "jtarboxme@gmail.com|submit@meetmeatthefair.com",
    };
    expect(
      resolveThread(
        { ...base, forwardOf: "Celina <celina.daigle@freedomboatclub.us>" },
        candidates,
        "N"
      )
    ).toEqual({ threadId: "TC", basis: "operator_forward" });
    // Same subject from SOMEONE ELSE is not the forwarded person's thread —
    // "Account creation" is a subject two strangers can share.
    const stranger = [{ ...candidates[0], threadId: "TS", fromAddress: "someone.else@z.test" }];
    expect(
      resolveThread({ ...base, forwardOf: "celina.daigle@freedomboatclub.us" }, stranger, "N").basis
    ).toBe("new");
    // No hint (an untrusted forwarder) → the forwarder is the person waiting.
    expect(resolveThread(base, candidates, "N").basis).toBe("new");
    // A different subject is a different conversation, even from the same person.
    expect(
      resolveThread(
        {
          ...base,
          subject: "Fwd: Washington County Fair",
          forwardOf: "celina.daigle@freedomboatclub.us",
        },
        candidates,
        "N"
      ).basis
    ).toBe("new");
  });

  it("the person a forward is waiting for is the ORIGINAL sender, not the operator", () => {
    expect(
      correspondentKey({
        fromAddress: "jtarboxme@gmail.com",
        originalSenderAddress: "Celina.Daigle@freedomboatclub.us",
        threadBasis: "operator_forward",
      })
    ).toBe("celina.daigle@freedomboatclub.us");
    // Not an operator forward → the sender, whatever the nested From says.
    expect(
      correspondentKey({
        fromAddress: "someone@x.test",
        originalSenderAddress: "other@y.test",
        threadBasis: "new",
      })
    ).toBe("someone@x.test");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the header chain through OUR OWN sends (ingest + backfill)", () => {
  it("queries Message-IDs as STORED — case and brackets kept, both spellings", () => {
    const forms = storedMessageIdForms(
      "<mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com>",
      null
    );
    expect(forms).toContain("<mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com>");
    expect(forms).toContain("mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com");
    expect(forms.every((f) => f === f.toLowerCase())).toBe(false);
  });

  it("stays under D1's 100 bound parameters on a long References chain, keeping the newest", () => {
    const refs = Array.from({ length: 120 }, (_, i) => `<r${i}@x.test>`).join(" ");
    const forms = storedMessageIdForms("<parent@x.test>", refs);
    expect(forms.length).toBeLessThanOrEqual(80);
    expect(forms).toContain("<parent@x.test>");
    expect(forms).toContain("<r119@x.test>");
    expect(forms).not.toContain("<r0@x.test>");
  });
});

// ─────────────────────────────────────────────────────────────────────────
const row = (o: Partial<BackfillInboundRow> & { id: string; receivedAt: number }) =>
  ({
    fromAddress: null,
    toAddress: "support@meetmeatthefair.com",
    subject: null,
    messageId: null,
    inReplyTo: null,
    emailReferences: null,
    originalSenderAddress: null,
    threadId: null,
    threadPosition: null,
    ...o,
  }) as BackfillInboundRow;

const CELINA = "celina.daigle@freedomboatclub.us";
const T = (d: string) => Date.parse(d);
/** Celina's five rows + John's forward, as in prod (subjects, ids, header ids). */
const CELINA_ROWS = [
  row({
    id: "cae4be85",
    receivedAt: T("2026-07-09T17:34:08Z"),
    fromAddress: CELINA,
    subject: "Account creation",
    messageId: "<DM3-a@x>",
  }),
  row({
    id: "2c194709",
    receivedAt: T("2026-07-09T20:18:19Z"),
    fromAddress: "jtarboxme@gmail.com",
    toAddress: "submit@meetmeatthefair.com",
    subject: "Fwd: Account creation",
    messageId: "<CAEv@x>",
  }),
  row({
    id: "b62e4a83",
    receivedAt: T("2026-07-14T12:29:15Z"),
    fromAddress: CELINA,
    toAddress: "hello@meetmeatthefair.com",
    subject: "Washington County Fair",
    messageId: "<DM3-b@x>",
  }),
  row({
    id: "8334796b",
    receivedAt: T("2026-07-14T12:31:05Z"),
    fromAddress: CELINA,
    toAddress: "submit@meetmeatthefair.com",
    subject: "Washington County Fair Inquiry",
    messageId: "<DM3-c@x>",
  }),
  row({
    id: "67612788",
    receivedAt: T("2026-09-01T16:42:58Z"),
    fromAddress: CELINA,
    subject: "Re: One thing I should have mentioned — your Freedom Boat Club listing",
    messageId: "<DM3-d@x>",
    inReplyTo: "<mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com>",
  }),
  row({
    id: "68619110",
    receivedAt: T("2026-09-02T14:54:23Z"),
    fromAddress: CELINA,
    subject: "Re: One thing I should have mentioned — your Freedom Boat Club listing",
    messageId: "<DM3-e@x>",
    inReplyTo: "<7Jod1WtqCWZR9dEOya2keUwZTZajQ5bNRmBt@meetmeatthefair.com>",
  }),
];
/** Our sends, with the inbound row each one answered (email_send_ledger). */
const CELINA_LEDGER = [
  {
    providerMessageId: "<mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com>",
    inboundEmailId: "8334796b",
  },
  {
    providerMessageId: "<7Jod1WtqCWZR9dEOya2keUwZTZajQ5bNRmBt@meetmeatthefair.com>",
    inboundEmailId: "67612788",
  },
];

describe("scope 5 — backfill plan", () => {
  let n = 0;
  const id = () => `new-${++n}`;

  it("Celina: her two replies chain EXACTLY through our sends to the 07-14 inquiry", () => {
    const plan = planThreadBackfill(CELINA_ROWS, CELINA_LEDGER, new Set(), id);
    const t = new Map(plan.assignments.map((a) => [a.id, a]));
    expect(t.get("67612788")!.threadId).toBe(t.get("8334796b")!.threadId);
    expect(t.get("68619110")!.threadId).toBe(t.get("8334796b")!.threadId);
    expect(t.get("67612788")!.threadBasis).toBe("header_chain");
    expect(t.get("68619110")!.threadBasis).toBe("header_chain");
    expect(t.get("68619110")!.threadPosition).toBe(3);
  });

  it("Celina: differently-subjected messages stay separate conversations (scope 5: no guessing)", () => {
    const plan = planThreadBackfill(CELINA_ROWS, CELINA_LEDGER, new Set(), id);
    const t = new Map(plan.assignments.map((a) => [a.id, a.threadId]));
    expect(t.get("cae4be85")).not.toBe(t.get("b62e4a83"));
    // "Washington County Fair" vs "… Inquiry", to different addresses.
    expect(t.get("b62e4a83")).not.toBe(t.get("8334796b"));
  });

  it("2c194709 (John's forward) joins Celina's thread ONLY when its nested sender is known", () => {
    const trusted = new Set(["jtarboxme@gmail.com"]);
    // As in prod: the row predates forward capture, original_sender_address NULL.
    const asIs = planThreadBackfill(CELINA_ROWS, CELINA_LEDGER, trusted, id);
    expect(asIs.assignments.find((a) => a.id === "2c194709")!.threadBasis).toBe("new");
    // With the nested From captured (every forward since OPE-944):
    const withOrig = CELINA_ROWS.map((r) =>
      r.id === "2c194709" ? { ...r, originalSenderAddress: CELINA } : r
    );
    const plan = planThreadBackfill(withOrig, CELINA_LEDGER, trusted, id);
    const t = new Map(plan.assignments.map((a) => [a.id, a]));
    expect(t.get("2c194709")!.threadBasis).toBe("operator_forward");
    expect(t.get("2c194709")!.threadId).toBe(t.get("cae4be85")!.threadId);
    // …and an UNtrusted forwarder never joins someone else's thread.
    const untrusted = planThreadBackfill(withOrig, CELINA_LEDGER, new Set(), id);
    expect(untrusted.assignments.find((a) => a.id === "2c194709")!.threadBasis).toBe("new");
  });

  it("NEGATIVE CONTROL: Holly Plush Cargo's two 08-05 rows (different to-addresses) stay apart", () => {
    const holly = [
      row({
        id: "47d77f37",
        receivedAt: T("2026-08-05T15:14:47Z"),
        fromAddress: "holly@plushcargo.com",
        subject: "Event merch for fairs and festivals",
        messageId: "<010e-1@x>",
      }),
      row({
        id: "5be28ce5",
        receivedAt: T("2026-08-05T15:14:48Z"),
        fromAddress: "holly@plushcargo.com",
        toAddress: "hello@meetmeatthefair.com",
        subject: "Event merch for fairs and festivals",
        messageId: "<010e-2@x>",
      }),
    ];
    const plan = planThreadBackfill(holly, [], new Set(), id);
    expect(plan.byBasis.new).toBe(2);
    expect(plan.multiMessageThreads).toBe(0);
  });

  it("same subject AND same participants DO join (the weak tier, as at ingest)", () => {
    const rows = [
      row({
        id: "q1",
        receivedAt: 1,
        fromAddress: "a@x.test",
        subject: "Booth size for Fryeburg Fair",
      }),
      row({
        id: "q2",
        receivedAt: 2,
        fromAddress: "a@x.test",
        subject: "RE: Booth size for Fryeburg Fair",
      }),
    ];
    const plan = planThreadBackfill(rows, [], new Set(), id);
    expect(plan.byBasis).toMatchObject({ new: 1, subject_participants: 1 });
    expect(plan.multiMessageThreads).toBe(1);
  });

  it("an already-threaded row is never re-decided, and later rows can join it", () => {
    const rows = [
      row({
        id: "old",
        receivedAt: 1,
        fromAddress: "a@x.test",
        subject: "Booth size for Fryeburg Fair",
      }),
      row({
        id: "live",
        receivedAt: 2,
        fromAddress: "a@x.test",
        subject: "Something else entirely here",
        threadId: "LIVE",
        threadPosition: 1,
      }),
    ];
    const plan = planThreadBackfill(rows, [], new Set(), id);
    expect(plan.assignments.map((a) => a.id)).toEqual(["old"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("scope 5 — the backfill tool", () => {
  async function seedCelina() {
    for (const r of CELINA_ROWS) {
      await db.insert(inboundEmails).values({
        id: r.id,
        sessionId: `s-${r.id}`,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        subject: r.subject,
        messageId: r.messageId,
        inReplyTo: r.inReplyTo,
        receivedAt: new Date(r.receivedAt),
        createdAt: new Date(r.receivedAt),
        status: "received",
      } as never);
    }
    for (const [i, l] of CELINA_LEDGER.entries()) {
      await db.insert(emailSendLedger).values({
        messageId: `m${i}`,
        sentAt: new Date(),
        providerMessageId: l.providerMessageId,
        inboundEmailId: l.inboundEmailId,
      } as never);
    }
    await db.insert(inboundEmailSenders).values({
      email: "jtarboxme@gmail.com",
      trustStatus: "trusted",
    } as never);
  }
  const threads = () => db.select().from(inboundEmails).all();

  it("DRY RUN (the default) reports the basis counts and writes NOTHING", async () => {
    await seedCelina();
    const out = json(await tools().get("backfill_email_threads")!({ dry_run: true }));
    expect(out.dryRun).toBe(true);
    expect(out.rowsNeedingThread).toBe(6);
    expect(out.byBasis).toMatchObject({ header_chain: 2, new: 4 });
    expect(threads().every((r: any) => r.threadId === null)).toBe(true);
    expect(db.select().from(adminActions).all()).toHaveLength(0);
  });

  it("dry_run=false writes, reads back zero NULL, logs the rollback ids, and is idempotent", async () => {
    await seedCelina();
    const out = json(await tools().get("backfill_email_threads")!({ dry_run: false }));
    expect(out.written).toBe(6);
    expect(out.stillNull).toBe(0);
    const log = db.select().from(adminActions).all();
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].payloadJson).ids).toHaveLength(6);
    const before = threads().map((r: any) => r.threadId);
    const again = json(await tools().get("backfill_email_threads")!({ dry_run: false }));
    expect(again.written).toBe(0);
    expect(threads().map((r: any) => r.threadId)).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("scope 4 — get_email_thread", () => {
  it("returns every message in AND out, in time order, plus the sender's other messages", async () => {
    const at = (s: string) => new Date(s);
    for (const [id, subj, when, thread] of [
      ["8334796b", "Washington County Fair Inquiry", "2026-07-14T12:31:05Z", "TW"],
      ["67612788", "Re: One thing I should have mentioned", "2026-09-01T16:42:58Z", "TW"],
      ["cae4be85", "Account creation", "2026-07-09T17:34:08Z", "TA"],
    ] as const) {
      await db.insert(inboundEmails).values({
        id,
        sessionId: `s-${id}`,
        fromAddress: CELINA,
        toAddress: "support@meetmeatthefair.com",
        subject: subj,
        threadId: thread,
        bodyText: `body of ${id}`,
        receivedAt: at(when),
        createdAt: at(when),
        status: "received",
      } as never);
    }
    await db.insert(emailSendLedger).values({
      messageId: "10d9b097",
      sentAt: at("2026-08-31T17:30:08Z"),
      recipient: CELINA,
      subject: "One thing I should have mentioned — your Freedom Boat Club listing",
      inboundEmailId: "8334796b",
      source: "reply:manual",
      bodyText: "our reply",
    } as never);

    const out = json(await tools().get("get_email_thread")!({ inbound_email_id: "67612788" }));
    expect(out.messages.map((m: any) => [m.direction, m.id])).toEqual([
      ["in", "8334796b"],
      ["out", "10d9b097"],
      ["in", "67612788"],
    ]);
    expect(out.sameSenderOtherMessages.map((m: any) => m.id)).toEqual(["cae4be85"]);
    expect(out.messages[1].excerpt).toBe("our reply");
  });

  it("a pre-threading row is reported as its own one-message conversation, not widened", async () => {
    await inbound({ id: "solo", fromAddress: "p@x.test", subject: "hi" });
    await inbound({ id: "other", fromAddress: "p@x.test", subject: "hello again" });
    const out = json(await tools().get("get_email_thread")!({ inbound_email_id: "solo" }));
    expect(out.threaded).toBe(false);
    expect(out.messages.map((m: any) => m.id)).toEqual(["solo"]);
    expect(out.sameSenderOtherMessages.map((m: any) => m.id)).toEqual(["other"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("ingest — resolveThreadColumns against a real (sqlite) table", () => {
  const env = { DB: {} as never } as never;
  const resolve = (a: Record<string, unknown>) =>
    resolveThreadColumns(env, "sess", {
      fromAddr: CELINA,
      toAddr: "support@meetmeatthefair.com",
      subject: null,
      inReplyTo: null,
      emailReferences: null,
      ...a,
    } as never);

  it("a reply to OUR send joins the thread of the inbound that send answered", async () => {
    await inbound({
      id: "8334796b",
      fromAddress: CELINA,
      subject: "Washington County Fair Inquiry",
      threadId: "TW",
      threadPosition: 1,
    });
    await db.insert(emailSendLedger).values({
      messageId: "10d9b097",
      sentAt: new Date(),
      providerMessageId: "<mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com>",
      inboundEmailId: "8334796b",
    } as never);
    const r = await resolve({
      subject: "Re: One thing I should have mentioned",
      inReplyTo: "<mSVukrjWrAwoJiL8hXNXdN8K0HHceGS8JIoZ@meetmeatthefair.com>",
    });
    expect(r).toEqual({ threadId: "TW", threadPosition: 2, threadBasis: "header_chain" });
  });

  it("a MIXED-CASE Message-ID from ANOTHER sender still matches (the case-folded lookup never did)", async () => {
    await inbound({
      id: "o1",
      fromAddress: "organizer@x.test",
      messageId: "<DM3PPF334FD9217BF8@x.test>",
      threadId: "TO",
      threadPosition: 1,
    });
    // A colleague replies-all: different sender, so `recent` cannot rescue it.
    const r = await resolve({
      fromAddr: "colleague@x.test",
      inReplyTo: "<DM3PPF334FD9217BF8@x.test>",
    });
    expect(r.threadBasis).toBe("header_chain");
    expect(r.threadId).toBe("TO");
  });

  it("a TRUSTED sender's forward joins the original sender's thread; an untrusted one does not", async () => {
    await inbound({
      id: "cae4be85",
      fromAddress: CELINA,
      subject: "Account creation",
      threadId: "TA",
      threadPosition: 1,
    });
    await db
      .insert(inboundEmailSenders)
      .values({ email: "jtarboxme@gmail.com", trustStatus: "trusted" } as never);
    const fwd = {
      subject: "Fwd: Account creation",
      toAddr: "submit@meetmeatthefair.com",
      forwardOriginalSender: CELINA,
    };
    expect(await resolve({ ...fwd, fromAddr: "jtarboxme@gmail.com" })).toMatchObject({
      threadId: "TA",
      threadBasis: "operator_forward",
    });
    expect((await resolve({ ...fwd, fromAddr: "stranger@y.test" })).threadBasis).toBe("new");
  });
});
