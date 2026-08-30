/**
 * OPE-643 — four writers promised "State (2-letter code)" and enforced nothing.
 *
 * The gap between a DESCRIBED contract and an ENFORCED one is exactly the width
 * of the bad row. Measured on prod 2026-08-30:
 *
 *   create_venue      z.string().min(1).max(2)   ->  venues.state:   0 non-US values
 *   update_venue      z.string()  (unbounded)
 *   update_vendor     z.string()  (unbounded)    ->  vendors.state:  "FINLAND"
 *   create_promoter   z.string()  (unbounded)
 *   update_promoter   z.string()  (unbounded)
 *
 * The one writer that enforced the contract has the clean column. That is not a
 * coincidence worth arguing about.
 *
 * Format only, deliberately. A valid 2-letter non-US code like "ON" stays
 * storable — Rossiter Boats really is in Ontario. Whether such a code gets a
 * "By state" browse page is a separate VOCABULARY question, answered by
 * isBrowseStateCode() in the app, and the two must not be conflated: a writer
 * that enforced US-only would refuse true information.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

const WRITERS = ["update_venue", "update_vendor", "create_promoter", "update_promoter"] as const;

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
});

/** Does this tool's own zod shape accept the given state value? */
function accepts(tool: string, state: string): boolean {
  const shape = server.schemas.get(tool);
  if (!shape) throw new Error(`Tool not registered: ${tool}`);
  return shape.state.safeParse(state).success;
}

describe("state is a 2-letter code, enforced not merely described (OPE-643)", () => {
  it.each(WRITERS)("%s rejects a country name in the state column", (tool) => {
    // The literal prod value: Axopar Boats Oy, Helsinki, state='FINLAND'.
    expect(accepts(tool, "FINLAND")).toBe(false);
  });

  it.each(WRITERS)("%s rejects a spelled-out state name", (tool) => {
    // The near-miss that would look right to a caller and store wrong.
    expect(accepts(tool, "Maine")).toBe(false);
  });

  it.each(WRITERS)("%s still accepts a real 2-letter code", (tool) => {
    expect(accepts(tool, "ME")).toBe(true);
  });

  it.each(WRITERS)("%s still accepts a non-US 2-letter code", (tool) => {
    // Format, not vocabulary. Refusing "ON" here would refuse true information
    // about a real Ontario business; it is the FACET that is US-only.
    expect(accepts(tool, "ON")).toBe(true);
  });

  it("create_venue, which already enforced the contract, is unchanged", () => {
    // The control. Its column is the clean one; nothing here should alter it.
    expect(accepts("create_venue", "ME")).toBe(true);
    expect(accepts("create_venue", "FINLAND")).toBe(false);
    expect(accepts("create_venue", "")).toBe(false); // min(1) — still required
  });

  it("rejects through the real invoke path, not only the bare schema", async () => {
    const res = (await server.invoke("update_vendor", {
      vendor_id: "v-1",
      state: "FINLAND",
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("state");
  });
});
