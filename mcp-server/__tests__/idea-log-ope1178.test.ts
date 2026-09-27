/**
 * OPE-1178 — the idea log round-trips through its three MCP tools.
 *
 * Pinned beside each positive case is the thing it must refuse: an email
 * address in `source_person`, and a `related_refs` entry of an unknown kind.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerIdeaTools } from "../src/tools/admin-ideas.js";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerIdeaTools(server as never, db as never, { role: "ADMIN", userId: "admin-1" } as never);
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await server.invoke(name, args)) as {
    content: { text?: string }[];
    isError?: boolean;
  };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text ?? "{}") };
};

const SEED = {
  title: "Gift a vendor booth",
  description: "Let someone pay a vendor's booth fee on their behalf.",
  product: "mmatf",
  area: "vendors / payments",
  source_type: "customer_email",
  source_ref: "5635d5fa-4a5b-4ad2-85d8-a0971c087736",
  source_person: "Anthony Farrow",
  related_refs: ["problem_reports:pr-1"],
};

describe("add_idea / list_ideas / update_idea", () => {
  it("ACCEPTANCE: related_refs round-trips through add, update and list", async () => {
    const added = await call("add_idea", SEED);
    expect(added.isError).toBe(false);
    const id = added.body.idea.id;
    expect(added.body.idea).toMatchObject({ status: "new", votes: 1, createdBy: "admin-1" });
    expect(added.body.idea.relatedRefs).toEqual(["problem_reports:pr-1"]);

    const updated = await call("update_idea", {
      id,
      add_related_refs: ["idea:other-1", "problem_reports:pr-1"],
      bump_vote: true,
      extra_source_ref: "inbound:abc",
      status: "considering",
      linked_issue: "OPE-9999",
    });
    expect(updated.body.idea.relatedRefs).toEqual(["problem_reports:pr-1", "idea:other-1"]);
    expect(updated.body.idea).toMatchObject({
      votes: 2,
      status: "considering",
      linkedIssue: "OPE-9999",
      extraSourceRefs: ["inbound:abc"],
    });

    const byRef = await call("list_ideas", { related_ref: "idea:other-1" });
    expect(byRef.body.count).toBe(1);
    expect(byRef.body.ideas[0].id).toBe(id);
    // Landmark: an unrelated ref matches nothing, so count 1 above is not "everything".
    expect((await call("list_ideas", { related_ref: "idea:nope" })).body.count).toBe(0);
  });

  it("filters by status, product and text", async () => {
    await call("add_idea", SEED);
    await call("add_idea", { title: "Card subscription box", product: "cardworks" });
    expect((await call("list_ideas", { product: "cardworks" })).body.count).toBe(1);
    expect((await call("list_ideas", { query: "BOOTH FEE" })).body.count).toBe(1);
    expect((await call("list_ideas", { area: "payments" })).body.count).toBe(1);
    expect((await call("list_ideas", { status: "shipped" })).body.count).toBe(0);
    expect((await call("list_ideas", {})).body.count).toBe(2);
  });

  it("refuses an email address in source_person — a name only", async () => {
    const r = await call("add_idea", { ...SEED, source_person: "someone@example.com" });
    expect(r.isError).toBe(true);
    expect((await call("list_ideas", {})).body.count).toBe(0);
  });

  it("refuses a related_ref of an unknown kind", async () => {
    const r = await call("add_idea", { ...SEED, related_refs: ["users:123"] });
    expect(r.isError).toBe(true);
  });

  it("update_idea on a missing id is an error, not a silent success", async () => {
    expect((await call("update_idea", { id: "missing", status: "declined" })).isError).toBe(true);
  });
});
