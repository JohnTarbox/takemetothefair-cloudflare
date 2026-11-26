/**
 * OPE-1683 — an approved operator draft John composed by hand (no inbound link)
 * answers its recipient's open CONTACT obligation. Both live specimens
 * (Harvard Square 2026-11-15, OHTM 2026-11-18) stayed open and were closed by
 * hand as `not_needed`. Drives the real email-jobs consumer, the real MCP tool
 * handlers and the real backfill migration against SQLite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, supportObligations } from "../src/schema.js";
import {
  AUTO_CLOSED_BY_DRAFT,
  recipientAddresses,
  shouldCloseByAddressOnSend,
} from "../src/support-obligations-close.js";

const harness: { db: TestDb; raw: ReturnType<typeof createTestDb>["raw"] } = {
  db: null as unknown as TestDb,
  raw: null as never,
};
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn() }));
const { handleEmailBatch } = await import("../src/queue-consumers.js");
const { registerSupportObligationTools } =
  await import("../src/tools/admin-support-obligations.js");

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const SAMMI = "sammi@museum.example";
const OPENED = new Date("2026-11-17T21:49:52Z");

function obligation(
  id: string,
  over: { kind?: string; from?: string; openedAt?: Date; status?: string } = {}
) {
  harness.db
    .insert(supportObligations)
    .values({
      id,
      inboundEmailId: `in-${id}`,
      fromAddress: over.from ?? SAMMI,
      subject: "Re: New Promotor Account",
      openedAt: over.openedAt ?? OPENED,
      status: over.status ?? "open",
      kind: over.kind ?? "contact",
    } as never)
    .run();
}
const row = (id: string) =>
  harness.db.select().from(supportObligations).where(eq(supportObligations.id, id)).all()[0];

function draftJob(over: Record<string, unknown> = {}) {
  return {
    id: "ledger-draft-1",
    attempts: 1,
    body: {
      to: `Sammi G <${SAMMI.toUpperCase()}>`,
      subject: "Re: your camps",
      html: "<p>Thanks — the camps are listed.</p>",
      text: "Thanks — the camps are listed.",
      source: "operator:outbound",
      operatorDraftId: "9fdc56e6",
      ...over,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
async function send(m: ReturnType<typeof draftJob>, ok = true) {
  const env = {
    DB: {} as D1Database,
    EMAIL: {
      send: vi.fn(async () => {
        if (!ok) throw new Error("Cannot send emails to this recipient. suppressed");
        return { messageId: "prov-9" };
      }),
    },
    EMAIL_REPLY_ENABLED: "true",
  };
  await handleEmailBatch({ messages: [m] } as never, env as never);
}

beforeEach(() => {
  ({ db: harness.db, raw: harness.raw } = createTestDb());
  harness.raw["exec"](`DROP TABLE IF EXISTS support_obligations;\n${ddlFor(supportObligations)}`);
});

describe("OPE-1683 — a sent hand-composed draft answers the contact's obligation", () => {
  it("ACCEPTANCE: closes the open contact obligation as answered, naming the draft — and nothing else", async () => {
    obligation("contact-open");
    obligation("support-same-person", { kind: "support" });
    obligation("contact-other-person", { from: "someone@else.example" });
    obligation("contact-opened-after", { openedAt: new Date(Date.now() + 3_600_000) });
    await send(draftJob());

    expect(row("contact-open")).toMatchObject({
      status: "answered",
      closedBy: AUTO_CLOSED_BY_DRAFT,
    });
    expect(row("contact-open").closeNote).toContain("9fdc56e6");
    expect(row("contact-open").closeNote).toContain("email_send_ledger.message_id=ledger-draft-1");
    // Landmarks: the same send leaves every out-of-scope row open.
    expect(row("support-same-person").status).toBe("open");
    expect(row("contact-other-person").status).toBe("open");
    expect(row("contact-opened-after").status).toBe("open");
  });

  it("a stored 'Name <addr>' sender matches too", async () => {
    obligation("named", { from: `Sammi G <${SAMMI}>` });
    await send(draftJob());
    expect(row("named").status).toBe("answered");
  });

  it("a send that fails closes nothing", async () => {
    obligation("contact-open");
    await send(draftJob(), false);
    expect(row("contact-open").status).toBe("open");
  });

  it("a draft linked to an inbound keeps the OPE-1252 conversation rule, not the address rule", () => {
    expect(shouldCloseByAddressOnSend({ source: "operator:outbound", operatorDraftId: "d" })).toBe(
      true
    );
    expect(
      shouldCloseByAddressOnSend({
        source: "operator:outbound",
        operatorDraftId: "d",
        inboundEmailId: "m1",
      })
    ).toBe(false);
    expect(shouldCloseByAddressOnSend({ source: "reply:manual", operatorDraftId: "d" })).toBe(
      false
    );
    expect(recipientAddresses(`A <A@x.example>, b@y.example`)).toEqual([
      "a@x.example",
      "b@y.example",
    ]);
  });
});

// ── the MCP tools ────────────────────────────────────────────────────────────

function toolsOf(register: (server: never) => void) {
  const handlers = new Map<
    string,
    (args: never) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >();
  register({
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as never);
    },
  } as never);
  return handlers;
}
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const admin = { role: "ADMIN", userId: "admin-1" } as never;
const tool = (name: string) =>
  toolsOf((s) => registerSupportObligationTools(s, harness.db as never, admin)).get(name)!;

function ledgerDraftSend(sentAt: Date, status = "sent") {
  harness.db
    .insert(emailSendLedger)
    .values({
      messageId: `draft-${sentAt.getTime()}`,
      sentAt,
      recipient: SAMMI,
      source: "operator:outbound",
      status,
    } as never)
    .run();
}

describe("OPE-1683 — the tools see an operator-draft send as an answer", () => {
  it("list_support_obligations reports lastManualReplySource: operator:outbound", async () => {
    obligation("contact-open");
    ledgerDraftSend(new Date(OPENED.getTime() + 60_000));
    const out = parse(await tool("list_support_obligations")({ status: "open" } as never));
    const o = out.obligations.find((x: { id: string }) => x.id === "contact-open");
    expect(o).toMatchObject({
      lastManualReplySource: "operator:outbound",
      answerSignal: "answered_not_closed",
    });
  });

  it("resolve answered is accepted with a sent draft after openedAt, at the send time", async () => {
    obligation("contact-open");
    const sentAt = new Date(OPENED.getTime() + 120_000);
    ledgerDraftSend(sentAt);
    const r = parse(
      await tool("resolve_support_obligation")({ id: "contact-open", status: "answered" } as never)
    );
    expect(r.ok).toBe(true);
    expect(row("contact-open").status).toBe("answered");
    expect(row("contact-open").closedAt!.getTime()).toBe(
      Math.floor(sentAt.getTime() / 1000) * 1000
    );
  });

  it("…and still refused with no draft, or only one sent BEFORE the obligation opened", async () => {
    obligation("contact-open");
    ledgerDraftSend(new Date(OPENED.getTime() - 60_000));
    ledgerDraftSend(new Date(OPENED.getTime() + 60_000), "failed");
    const r = parse(
      await tool("resolve_support_obligation")({ id: "contact-open", status: "answered" } as never)
    );
    expect(r.error).toBe("refused");
    expect(row("contact-open").status).toBe("open");
  });
});

// ── the backfill ─────────────────────────────────────────────────────────────

describe("0430 backfill", () => {
  const SQL = readFileSync(
    join(__dirname, "../../drizzle/0430_ope1683_backfill_operator_draft_answered.sql"),
    "utf8"
  );
  const IDS = ["ae03f162-238a-4b13-9c2b-212fc5f2c710", "62696e98-39c0-4537-8410-171815a58ab9"];

  it("is a no-op on an empty database", () => {
    expect(() => harness.raw["exec"](SQL)).not.toThrow();
    expect(harness.db.select().from(supportObligations).all()).toHaveLength(0);
  });

  it("re-marks exactly the two rows, at the draft send times, keeping the original note; a re-run changes nothing", () => {
    for (const id of IDS) {
      obligation(id, { status: "not_needed" });
      harness.raw["exec"](
        `UPDATE support_obligations SET close_note='Reply WAS sent', closed_by='admin-user-001' WHERE id='${id}'`
      );
    }
    obligation("another-not-needed", { status: "not_needed" });
    harness.raw["exec"](SQL);
    expect(row(IDS[0])).toMatchObject({ status: "answered", closedBy: "backfill:OPE-1683" });
    expect(row(IDS[0]).closedAt!.getTime()).toBe(1794791278 * 1000);
    expect(row(IDS[1]).closedAt!.getTime()).toBe(1795003738 * 1000);
    expect(row(IDS[1]).closeNote).toMatch(/9fdc56e6.*Original note: Reply WAS sent$/);
    expect(row("another-not-needed").status).toBe("not_needed");
    const note = row(IDS[0]).closeNote;
    harness.raw["exec"](SQL);
    expect(row(IDS[0]).closeNote).toBe(note);
  });
});
