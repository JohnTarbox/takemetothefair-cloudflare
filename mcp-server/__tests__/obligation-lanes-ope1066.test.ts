/**
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

const seed = async (id: string, intent: string | null, from: string, confidence = 0.9) => {
  await db.insert(inboundEmails).values({
    id,
    sessionId: `s-${id}`,
    fromAddress: from,
    toAddress: "hello@meetmeatthefair.com",
    subject: `subject ${id}`,
    intent: "correction",
    classifiedIntent: intent,
    classifiedConfidence: confidence,
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

describe("openObligationIfOwed — the three lanes that were invisible (OPE-1066)", () => {
  // The real senders from the ticket's measured table.
  it.each([
    ["correction", "gnancylasson@gmail.com"],
    ["claim_request", "guinther.sarah@gmail.com"],
    ["press", "advisor@flippa.com"],
  ])("opens an obligation for %s", async (intent, from) => {
    const row = await seed(`e-${intent}`, intent, from);
    const ref = await openObligationIfOwed({ DB: {} as never }, db, row, "test");

    expect(ref).toBeTruthy();
    const open = obligations();
    expect(open).toHaveLength(1);
    expect(open[0].inboundEmailId).toBe(`e-${intent}`);
    expect(open[0].status).toBe("open");
    expect(open[0].fromAddress).toBe(from);
  });

  it("opens one for a .gov correction — the sender class this most needed to see", async () => {
    const row = await seed("e-gov", "correction", "jeremy.hall@ct.gov");
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeTruthy();
    expect(obligations()).toHaveLength(1);
  });

  it("opens one for cold outreach too, deliberately", async () => {
    // aria@thetechnobrand.com is an SEO pitch classified `correction`. It lands
    // in the queue on purpose: nothing in a classified row separates it from a
    // real customer, and closing it as not_an_obligation takes seconds. Guessing
    // here is how OPE-365 was built — the system guessed importance, backwards.
    const row = await seed("e-pitch", "correction", "aria@thetechnobrand.com");
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeTruthy();
    expect(obligations()).toHaveLength(1);
  });

  it("still refuses a system sender on the new lanes", async () => {
    // The OPE-835 probe arrives from our own domain classified `support`; the
    // same exclusion must hold now that `correction` is obligating.
    const row = await seed("e-sys", "correction", "notify@meetmeatthefair.com");
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeNull();
    expect(obligations()).toHaveLength(0);
  });

  it("still refuses an intent that acts rather than defers", async () => {
    const row = await seed("e-sub", "submit", "someone@example.com");
    expect(await openObligationIfOwed({ DB: {} as never }, db, row, "test")).toBeNull();
    expect(obligations()).toHaveLength(0);
  });

  it("is idempotent — a Workflow retry does not open a second row", async () => {
    // Workflows are at-least-once. Without onConflictDoNothing a retried step
    // doubles the queue depth for one person.
    const row = await seed("e-retry", "correction", "ltzuc900@yahoo.com");
    const first = await openObligationIfOwed({ DB: {} as never }, db, row, "test");
    const second = await openObligationIfOwed({ DB: {} as never }, db, row, "test");

    expect(obligations()).toHaveLength(1);
    // And the ref must point at the row that EXISTS, not a freshly-minted uuid.
    expect(second).toBe(first);
  });
});

/**
 * The wiring half. A decision that is right but unreachable is what this ticket
 * is about — `correction` would have stayed invisible even with the allow-list
 * widened, because its handler never asked.
 *
 * Keyed on the ACT (an intent that acknowledges-and-defers) rather than on a
 * fixed list of files, so adding a seventh intent to ACK_TERMINATING_INTENTS
 * without wiring its handler fails here rather than in production.
 */
describe("every ack-terminating intent's handler actually asks (OPE-1066)", () => {
  const workflow = read("src/workflows/inbound-email.ts");

  /** `import { handle as handleCorrection } from "../email-handlers/correction.js";` */
  const importedModuleFor = (fnName: string): string | null => {
    const re = new RegExp(
      `import\\s*\\{\\s*handle as ${fnName}\\s*\\}\\s*from\\s*"\\.\\./email-handlers/([\\w.-]+)\\.js"`
    );
    return workflow.match(re)?.[1] ?? null;
  };

  /** The `HANDLERS` map entry: `correction: handleCorrection,` */
  const handlerFnFor = (intent: string): string | null =>
    workflow.match(new RegExp(`^\\s*${intent}:\\s*(handle\\w+)`, "m"))?.[1] ?? null;

  it("resolves every ack-terminating intent to a handler module", () => {
    // A positive landmark: if this parse silently found nothing, every
    // assertion below would pass vacuously.
    for (const intent of ACK_TERMINATING_INTENTS) {
      const fn = handlerFnFor(intent);
      expect(fn, `no HANDLERS entry for ${intent}`).toBeTruthy();
      expect(importedModuleFor(fn!), `no import for ${fn}`).toBeTruthy();
    }
    expect(ACK_TERMINATING_INTENTS.length).toBeGreaterThanOrEqual(6);
  });

  it.each([...ACK_TERMINATING_INTENTS])(
    "%s's handler calls openObligationIfOwed",
    (intent: string) => {
      const handlerModule = importedModuleFor(handlerFnFor(intent)!)!;
      // Import lines stripped first, and the CALL syntax matched rather than the
      // bare symbol. A plain `includes("openObligationIfOwed")` passes on the
      // import alone: deleting the call but leaving the import kept this test
      // green when it was written that way, which is the whole failure mode it
      // is supposed to catch.
      const src = read(`src/email-handlers/${handlerModule}.ts`)
        .split("\n")
        .filter((line) => !/^\s*import\b/.test(line))
        .join("\n");
      expect(
        /\bopenObligationIfOwed\s*\(/.test(src),
        `${handlerModule}.ts handles intent '${intent}', which acknowledges and defers, but never opens an obligation`
      ).toBe(true);
    }
  );
});
