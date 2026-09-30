/**
 * OPE-227 increment B — the MCP side of hero proposals.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  registerHeroProposalTools,
  HERO_ATTEMPT_ACTION,
  HERO_PROPOSED_ACTION,
  HERO_RESOLVED_ACTION,
} from "../src/tools/admin-hero-proposals.js";
import { adminActions } from "../src/schema.js";

describe("action names match the main app's (this Worker cannot import them)", () => {
  const appSrc = readFileSync(
    resolve(__dirname, "../../src/lib/photo-flywheel/hero-proposals.ts"),
    "utf8"
  );
  const value = (name: string) => appSrc.match(new RegExp(`export const ${name} = "([^"]+)"`))?.[1];
  it.each([
    ["HERO_PROPOSED_ACTION", HERO_PROPOSED_ACTION],
    ["HERO_ATTEMPT_ACTION", HERO_ATTEMPT_ACTION],
    ["HERO_RESOLVED_ACTION", HERO_RESOLVED_ACTION],
  ])("%s", (name, mcpValue) => {
    // Landmark: the regex found the constant at all.
    expect(value(name)).toBeTruthy();
    expect(mcpValue).toBe(value(name));
  });
});

describe("list_hero_proposals", () => {
  let db: TestDb;
  let server: CapturingMcpServer;
  const at = (s: string) => new Date(s);

  beforeEach(() => {
    ({ db } = createTestDb());
    server = new CapturingMcpServer();
    registerHeroProposalTools(server as never, db, { userId: "u", role: "ADMIN" } as never, {});
    const prop = (id: string, when: string, name: string) =>
      db
        .insert(adminActions)
        .values({
          id,
          action: HERO_PROPOSED_ACTION,
          targetType: "event",
          targetId: `e-${id}`,
          createdAt: at(when),
          payloadJson: JSON.stringify({
            event_id: `e-${id}`,
            event_name: name,
            event_slug: `s-${id}`,
            photo_url: `https://cdn/x-${id}.jpg`,
            width: 1200,
            height: 800,
          }),
        })
        .run();
    prop("p1", "2026-09-10T00:00:00Z", "Pending Fair");
    prop("p2", "2026-09-11T00:00:00Z", "Decided Fair");
    db.insert(adminActions)
      .values({
        id: "r2",
        action: HERO_RESOLVED_ACTION,
        targetType: "admin_action",
        targetId: "p2",
        createdAt: at("2026-09-12T00:00:00Z"),
        payloadJson: JSON.stringify({ resolution: "rejected" }),
      })
      .run();
  });

  const list = async (args: Record<string, unknown>) => {
    const r = (await server.invoke("list_hero_proposals", args)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(r.content[0].text);
  };

  it("defaults to PENDING only, and says how many are pending", async () => {
    const out = await list({});
    expect(out.proposals.map((p: { proposal_id: string }) => p.proposal_id)).toEqual(["p1"]);
    expect(out.pending_total).toBe(1);
    expect(out.proposals[0]).toMatchObject({
      event_name: "Pending Fair",
      dimensions: "1200x800",
      event_url: "https://meetmeatthefair.com/events/s-p1",
      status: "pending",
    });
  });

  it("shows a decided proposal with its resolution under resolved / all", async () => {
    expect(
      (await list({ status: "resolved" })).proposals.map((p: { status: string }) => p.status)
    ).toEqual(["rejected"]);
    expect((await list({ status: "all" })).count).toBe(2);
  });

  it("is not registered for a non-admin", () => {
    const s = new CapturingMcpServer();
    registerHeroProposalTools(s as never, db, { userId: "u", role: "VENDOR" } as never, {});
    expect(s.handlers.has("list_hero_proposals")).toBe(false);
    expect(s.handlers.has("resolve_hero_proposal")).toBe(false);
  });
});
