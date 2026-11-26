/**
 * OPE-1592 — a status change can carry why it happened and on what evidence.
 *
 * Specimen: 31 PENDING → TENTATIVE releases on 2026-11-09 each passed a
 * `reason`, and each came back `ignored_params: ["reason"]`. The events went
 * public and the reasoning survived only in a chat transcript.
 *
 * Driven through a real McpServer wrapped by applyToolParamPolicy, because that
 * wrapper is what dropped the key. CapturingMcpServer does not apply it, so a
 * harness test could not have seen the defect.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { applyToolParamPolicy } from "../src/tool-param-policy.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, events, promoters } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

const REASON = "Dates verified on organizer page";
const EVIDENCE = "https://example.org/fair/2026";

type CallResult = { isError?: boolean; content: { type: string; text?: string }[] };
type Raw = ReturnType<typeof createTestDb>["raw"];

let db: TestDb;
let raw: Raw;
let client: Client;
let mock: ReturnType<typeof mockIndexNowFetch>;

beforeEach(async () => {
  ({ db, raw } = createTestDb());
  mock = mockIndexNowFetch();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: unsafeSlug("p") })
    .run();
  db.insert(events)
    .values({
      id: "evt",
      name: "CCCWC Holiday Craft Fair 2026",
      slug: unsafeSlug("cccwc-holiday-craft-fair-2026"),
      promoterId: "p-1",
      status: "PENDING",
      isStatewide: true,
      stateCode: "ME",
    })
    .run();

  const server = applyToolParamPolicy(new McpServer({ name: "t", version: "0" }));
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "c", version: "0" });
  await client.connect(b);
});

afterEach(() => {
  mock.restore();
});

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallResult>;

const setTentative = (extra: Record<string, unknown> = {}) =>
  call("update_event_status", { event_id: "evt", status: "TENTATIVE", ...extra });

const body = (r: CallResult) => JSON.parse(r.content[0].text ?? "{}") as Record<string, unknown>;

const statusNow = () => db.select().from(events).where(eq(events.id, "evt")).all()[0].status;

const auditRows = () =>
  db.select().from(adminActions).where(eq(adminActions.action, "event.status_change")).all();

describe("update_event_status with reason + evidence_url", () => {
  it("ACCEPTANCE: returns both values, with no ignored_params entry", async () => {
    const res = await setTentative({ reason: REASON, evidence_url: EVIDENCE });
    expect(res.isError).toBeFalsy();
    const out = body(res);
    expect(out.reason).toBe(REASON);
    expect(out.evidence_url).toBe(EVIDENCE);
    expect(out.warnings).toBeUndefined();
    expect(statusNow()).toBe("TENTATIVE");
  });

  it("ACCEPTANCE: the ticket's json_extract query reads back those exact values", async () => {
    await setTentative({ reason: REASON, evidence_url: EVIDENCE });
    const row = raw
      .prepare(
        `SELECT json_extract(payload_json,'$.reason') AS reason,
                json_extract(payload_json,'$.evidence_url') AS evidence_url
           FROM admin_actions
          WHERE action='event.status_change' AND target_id='evt'
          ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { reason: string; evidence_url: string };
    expect(row).toEqual({ reason: REASON, evidence_url: EVIDENCE });
  });

  it("ACCEPTANCE: both values are visible through get_event_lifecycle_history", async () => {
    await setTentative({ reason: REASON, evidence_url: EVIDENCE });
    const out = body(await call("get_event_lifecycle_history", { event_id: "evt" })) as {
      timeline: { kind: string; details: Record<string, unknown> }[];
    };
    const entry = out.timeline.find((t) => t.kind === "event.status_change");
    expect(entry?.details).toMatchObject({
      previous_status: "PENDING",
      new_status: "TENTATIVE",
      reason: REASON,
      evidence_url: EVIDENCE,
    });
  });

  it("stores either value alone, without inventing the other", async () => {
    const out = body(await setTentative({ reason: REASON }));
    expect(out.reason).toBe(REASON);
    expect(out).not.toHaveProperty("evidence_url");
    const payload = JSON.parse(auditRows()[0].payloadJson ?? "{}") as Record<string, unknown>;
    expect(payload.reason).toBe(REASON);
    expect(payload).not.toHaveProperty("evidence_url");
  });

  it("decodes entity-encoded text, so the stored reason reads literally", async () => {
    const out = body(await setTentative({ reason: "Listed on Arts &amp; Crafts page" }));
    expect(out.reason).toBe("Listed on Arts & Crafts page");
  });
});

describe("update_event_status without them behaves as before", () => {
  it("ACCEPTANCE: the audit row has previous/new status and no provenance keys", async () => {
    const res = await setTentative();
    expect(res.isError).toBeFalsy();
    const rows = auditRows();
    // Positive landmark: the row this assertion is about exists.
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payloadJson ?? "{}")).toEqual({
      previous_status: "PENDING",
      new_status: "TENTATIVE",
      slug: "cccwc-holiday-craft-fair-2026",
    });
  });

  it("the response carries no provenance keys", async () => {
    const out = body(await setTentative());
    expect(Object.keys(out).sort()).toEqual(["event", "updated"]);
  });
});

describe("the unknown-param wrapper is still live on this tool", () => {
  // Without this control, the "no ignored_params" assertion above would pass
  // equally if the wrapper had stopped running.
  it("CONTROL: an undeclared key is still named in warnings.ignored_params", async () => {
    const out = body(await setTentative({ reason: REASON, bogus_key: "x" }));
    expect(out.warnings).toEqual({ ignored_params: ["bogus_key"] });
    expect(out.reason).toBe(REASON);
  });
});

describe("bad values are refused and change nothing", () => {
  it.each([
    ["a reason over 500 characters", { reason: "x".repeat(501) }],
    ["a blank reason", { reason: "   " }],
    ["an evidence_url that is not a URL", { evidence_url: "organizer page" }],
  ])("%s", async (_label, extra) => {
    const res = await setTentative(extra);
    expect(res.isError).toBe(true);
    expect(statusNow()).toBe("PENDING");
    expect(auditRows()).toHaveLength(0);
  });

  it("CONTROL: a reason of exactly 500 characters is accepted", async () => {
    const res = await setTentative({ reason: "x".repeat(500) });
    expect(res.isError).toBeFalsy();
    expect(statusNow()).toBe("TENTATIVE");
  });
});
