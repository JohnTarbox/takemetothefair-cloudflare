import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { registerInboundReadTools } from "../src/tools/admin-inbound-read.js";
import { recordWorkflowStep } from "../src/workflow-run-log.js";
import { inboundEmails } from "../src/schema.js";

/**
 * OPE-501 — `workflow_instance_id` was surfaced everywhere and accepted by
 * nothing. The question it could not answer, on the 2026-08-20 specimen: did
 * `ocr-attachments` run and produce nothing, or never run at all? Different
 * defects, different fixes, and the output row cannot tell them apart.
 */
function collect() {
  const tools = new Map<string, (a: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (n: string, _d: string, _s: unknown, cb: (a: never) => Promise<never>) =>
      void tools.set(n, cb as never),
  } as never;
  return { server, tools };
}

let db: TestDb;
let tools: ReturnType<typeof collect>["tools"];

async function call(args: unknown) {
  const res = await tools.get("get_workflow_instance")!(args as never);
  return JSON.parse(res.content[0].text);
}

beforeEach(async () => {
  ({ db } = createTestDb());
  const c = collect();
  registerInboundReadTools(c.server, db as never, { role: "ADMIN", userId: "u" } as never);
  tools = c.tools;

  await db.insert(inboundEmails).values({
    id: "em-1",
    receivedAt: new Date(),
    createdAt: new Date(),
    fromAddress: "a@b.com",
    toAddress: "submit@x",
    intent: "submit",
    status: "replied",
    replyKind: "ok-multi",
    attachmentCount: 1,
    workflowInstanceId: "wf-1",
  } as never);
});

describe("get_workflow_instance (OPE-501)", () => {
  it("distinguishes a SKIPPED step from one that ran — the whole point", async () => {
    await recordWorkflowStep(db as never, {
      instanceId: "wf-1",
      workflowName: "inbound-email",
      inboundEmailId: "em-1",
      stepName: "ocr-attachments",
      status: "skipped",
      detail: { reason: "attachment_count > 0 but attachment_refs is empty" },
    });

    const out = await call({ workflow_instance_id: "wf-1" });
    const ocr = out.steps.find((s: { step: string }) => s.step === "ocr-attachments");
    expect(ocr.status).toBe("skipped");
    // "never ran, and here is why" — the fact that was unobtainable.
    expect(ocr.detail.reason).toMatch(/attachment_refs is empty/);
  });

  it("records the source list so N-in vs M-out is attributable", async () => {
    await recordWorkflowStep(db as never, {
      instanceId: "wf-1",
      workflowName: "inbound-email",
      inboundEmailId: "em-1",
      stepName: "multi-source-fanout",
      status: "ok",
      detail: {
        source_count: 4,
        sources: [
          { kind: "url", ref: "https://a.example/1" },
          { kind: "url", ref: "https://a.example/2" },
          { kind: "body", ref: "body" },
          { kind: "attachment", ref: "flyer.png" },
        ],
      },
    });
    const out = await call({ workflow_instance_id: "wf-1" });
    const fan = out.steps.find((s: { step: string }) => s.step === "multi-source-fanout");
    expect(fan.detail.source_count).toBe(4);
    expect(fan.detail.sources.map((x: { kind: string }) => x.kind)).toContain("attachment");
  });

  it("resolves the run FROM the inbound email (item 3, both directions)", async () => {
    await recordWorkflowStep(db as never, {
      instanceId: "wf-1",
      workflowName: "inbound-email",
      inboundEmailId: "em-1",
      stepName: "ocr-attachments",
      status: "ok",
      detail: { sources_produced: 1 },
    });
    const out = await call({ inbound_email_id: "em-1" });
    expect(out.workflow_instance_id).toBe("wf-1");
    expect(out.step_count).toBe(1);
  });

  it("says a pre-OPE-501 run is opaque rather than implying nothing happened", async () => {
    const out = await call({ workflow_instance_id: "wf-unknown" });
    expect(out.step_count).toBe(0);
    expect(out.steps_note).toMatch(/not backfillable/i);
  });

  it("reports that live status is instance-level only, so nobody reads it as step history", async () => {
    const out = await call({ workflow_instance_id: "wf-1" });
    expect(out.live_status_note).toMatch(/no per-step history/i);
  });

  it("requires one of the two identifiers", async () => {
    const out = await call({});
    expect(out.error).toBe("workflow_instance_id_or_inbound_email_id_required");
  });
});
