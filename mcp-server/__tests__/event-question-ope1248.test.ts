/**
 * OPE-1248 — `event_question`, and the "Thanks for the info!" guard.
 *
 * Header below (DDL-from-schema + mocks) is reused verbatim from the OPE-1066
 * test; the original note follows.
 *
 * OPE-1066 — every acknowledge-and-defer lane opens an obligation.
 *
 * Two halves, because the production data showed each is necessary and neither
 * is sufficient. `inbound_emails` records both the intent that dispatched
 * (`intent`) and what the classifier said (`classified_intent`):
 *
 *   - `correction` @ 0.90 → `routing_source='classifier_override'` → dispatches
 *     to `correction.ts`, which never asked whether an obligation was owed.
 *   - `correction` @ 0.82 → fell back to `intent='support'` → `support.ts` DID
 *     ask, and was refused because `correction` was not on the allow-list.
 *
 * So: the DECISION half is tested against a real DB, and the WIRING half is
 * tested structurally — because a rule that is right and unreachable is exactly
 * how these twelve emails went missing for three weeks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { ACK_TERMINATING_INTENTS } from "@takemetothefair/utils";
import * as schema from "../src/schema.js";
import { supportObligations, inboundEmails } from "../src/schema.js";

/**
 * DDL generated FROM the Drizzle schema rather than hand-written.
 * `setup-db.ts` hand-writes a subset of tables, which is fine for its own
 * callers and wrong here: a hand-written fixture silently lacks whatever column
 * the code under test starts using next (OPE-793 lost eight tests to exactly
 * that). Generating it means this test cannot drift from the schema.
 */
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    // Column-level UNIQUE matters here: `support_obligations.inbound_email_id`
    // declares `.unique()` on the COLUMN, not as a table index, and it is what
    // makes `onConflictDoNothing` a real no-op on a Workflow retry.
    const unique = (c as unknown as { isUnique?: boolean }).isUnique ? " UNIQUE" : "";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}${unique}`;
  });
  const createTable = `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
  // Indexes too, and UNIQUE ones especially: `onConflictDoNothing` is a no-op
  // without the constraint it targets, so a fixture that omits the index tests
  // idempotency vacuously — it would pass with the guarantee removed.
  const indexes = cfg.indexes.map((idx) => {
    const cfgIdx = (
      idx as unknown as { config: { name: string; unique: boolean; columns: { name: string }[] } }
    ).config;
    const colNames = cfgIdx.columns.map((c) => c.name).join(", ");
    return `CREATE ${cfgIdx.unique ? "UNIQUE " : ""}INDEX ${cfgIdx.name} ON ${cfg.name} (${colNames});`;
  });
  return [createTable, ...indexes].join("\n");
}

const harness = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn() }));
// Suppression is a DB lookup in another module; the decision's own tests cover
// it. Here it must simply not be the thing under test.
vi.mock("../src/tools/admin-send-vendor-email.js", () => ({
  isEmailSuppressed: async () => false,
}));

const { openObligationIfOwed } = await import("../src/email-handlers/open-obligation.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

let db: any;

const OUR_MSG = "<HoYNa7BRLZK0ddErktGE6KMmK3qcPfNqoqCg@meetmeatthefair.com>";

const seed = async (
  id: string,
  intent: string,
  bodyText: string,
  inReplyTo: string | null = OUR_MSG
) => {
  await db.insert(inboundEmails).values({
    id,
    sessionId: `s-${id}`,
    fromAddress: `reader-${id}@example.com`,
    toAddress: "hello@meetmeatthefair.com",
    subject: `Re: subject ${id}`,
    intent: "support",
    classifiedIntent: intent,
    classifiedConfidence: 0.9,
    bodyText,
    inReplyTo,
    emailReferences: inReplyTo,
    receivedAt: new Date(),
    createdAt: new Date(),
    status: "received",
  } as never);
  return db
    .select()
    .from(inboundEmails)
    .all()
    .find((r: any) => r.id === id)!;
};
const obligations = () => db.select().from(supportObligations).all();

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  harness.db = drizzle(raw, { schema });
  db = harness.db;
});

// Real bodies, prod rows (sender text only; quoted part trimmed).
const E188 =
  " Thank you very much for including us!  Much appreciated.\nSincerely,\nDavid HarknessEvent Coordinator\n";
const C1C6 = "Thank you very much, you went way above and beyond what I expected.\n";
const A086 =
  "Thanks for the info!\n\nI'll reach out to them directly about the parking.\n\nLaura Kokoski\nNeighborhood Pet Services\n";
const FBD5 =
  "Can you rent wheelchairs at the festival?\n\n---\nhttps://meetmeatthefair.com/events/johnston-apple-festival-and-artisan-market\n\n";

describe("event_question opens a same-day obligation (OPE-1248)", () => {
  it("is on the ack-terminating allow-list", () => {
    expect(ACK_TERMINATING_INTENTS).toContain("event_question");
  });

  it("a fresh reader question (fbd5b1fc, not a reply) opens one", async () => {
    const row = await seed("fbd5", "event_question", FBD5, null);
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeTruthy();
    expect(obligations()).toHaveLength(1);
  });
});

describe("a thanks-only reply to our thread opens NO obligation (OPE-1248 ruling cond. 2)", () => {
  it.each([
    ["event_question", "e188", E188],
    ["event_question", "1c68", C1C6],
    ["claim_request", "e188c", E188], // what v7 says e188a9f7 is
    ["correction", "1c68c", C1C6], // what it was stored as
  ])("%s / %s", async (intent, id, text) => {
    const row = await seed(id, intent, text);
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeNull();
    expect(obligations()).toHaveLength(0);
  });

  // Positive landmark: same text, NOT a reply to us → still owed.
  it("the same thanks text NOT on our thread still opens one", async () => {
    const row = await seed("e188-cold", "event_question", E188, "<x@mail.gmail.com>");
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeTruthy();
    expect(obligations()).toHaveLength(1);
  });

  // The honest result for 086a5878: the closing test abstains on it, so it
  // is NOT guarded — it still opens an obligation (as it does today).
  it("086a5878 ('Thanks… I'll reach out about the parking') still opens one", async () => {
    const row = await seed("a086", "event_question", A086);
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeTruthy();
    expect(obligations()).toHaveLength(1);
  });
});

describe("event_question wiring (structural)", () => {
  it("dispatches to the support handler and is not in the admin-decision pause", () => {
    const wf = read("src/workflows/inbound-email.ts");
    expect(wf).toMatch(/^\s*event_question:\s*handleSupport,/m);
    const gate = wf.slice(
      wf.indexOf("const needsAdminDecision ="),
      wf.indexOf("const needsAdminDecision =") + 200
    );
    expect(gate).toContain('intent === "correction"');
    expect(gate).not.toContain("event_question");
  });

  it("gets the ruled support-ack, not a new copy", async () => {
    const { ackKindForIntent } = await import("../src/email-handlers/ack-kind.js");
    expect(ackKindForIntent("event_question")).toBe("support-ack");
  });

  it("the classifier accepts it", async () => {
    const { parseClassifierResponse } = await import("../src/intent-classifier.js");
    const [c] = parseClassifierResponse(
      '{"intent":"event_question","sub_intent":null,"confidence":0.96,"rationale":"r"}'
    );
    expect(c.intent).toBe("event_question");
  });

  it("the prompt defines it and the version is bumped", async () => {
    const p = await import("../src/intent-classifier-prompt.js");
    expect(p.INTENT_TAXONOMY_DOC).toMatch(/^- event_question:/m);
    expect(p.CLASSIFIER_VERSION).toBe("c-2026-11-04-v7");
  });
});
