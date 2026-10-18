/**
 * OPE-1486 — `get_send_gates` also answers for the gates that WRITE public
 * records, and the booth auto-write gate is committed OFF.
 *
 * The 2026-09-30 OPE-240 approval request said `PHOTO_AUTOWRITE_ENABLED
 * current: "false"`. It was quoted from the ticket's own description; the
 * Worker had been running "true" since #1425 (09-26). John ruled "keep it OFF"
 * on that premise, nothing reverted the line, and on 10-10 it auto-wrote five
 * vendors, three of them wrong. Two guards follow:
 *
 *   1. the deployed value is readable on demand (`write_gates`), so a receipt
 *      can quote it instead of reconstructing it;
 *   2. the committed value is pinned to John's ruling. Flipping it is his
 *      decision, and the person who flips it changes this test in the same PR.
 */
import { describe, it, expect } from "vitest";
import { readWranglerConfig, wranglerVars } from "../../scripts/lib/wrangler-config";
import { CapturingMcpServer } from "./setup-db.js";
import { registerSendGatesTool, WRITE_GATE_NAMES } from "../src/tools/admin-send-gates.js";

const ADMIN = { role: "ADMIN", userId: "admin-1" } as never;

type WriteGate = { name: string; value: string | null; enabled: boolean; unset_means: string };

async function writeGates(env: Record<string, string | undefined>) {
  const s = new CapturingMcpServer();
  registerSendGatesTool(s as never, {} as never, ADMIN, env);
  const res = (await s.invoke("get_send_gates", {})) as { content: Array<{ text: string }> };
  return (JSON.parse(res.content[0].text) as { write_gates: WriteGate[] }).write_gates;
}
const byName = (g: WriteGate[], n: string) => g.find((x) => x.name === n)!;

describe("get_send_gates → write_gates (OPE-1486)", () => {
  it("reports the value the Worker actually holds, true or false", async () => {
    expect(
      byName(await writeGates({ PHOTO_AUTOWRITE_ENABLED: "true" }), "PHOTO_AUTOWRITE_ENABLED")
    ).toMatchObject({ value: "true", enabled: true });
    expect(
      byName(await writeGates({ PHOTO_AUTOWRITE_ENABLED: "false" }), "PHOTO_AUTOWRITE_ENABLED")
    ).toMatchObject({ value: "false", enabled: false });
  });

  it('reports an unset gate as null and closed, matching `=== "true"` at the write site', async () => {
    const g = await writeGates({});
    expect(g).toHaveLength(WRITE_GATE_NAMES.length);
    for (const w of g)
      expect(w).toMatchObject({ value: null, enabled: false, unset_means: "closed" });
  });

  it("is admin-only, like the send gates", () => {
    const s = new CapturingMcpServer();
    registerSendGatesTool(s as never, {} as never, { role: "VENDOR", userId: "v" } as never, {});
    expect(s.handlers.has("get_send_gates")).toBe(false);
  });
});

describe("committed config — John's 2026-09-30 ruling on OPE-240 (OPE-1486)", () => {
  const mcpVars = wranglerVars(readWranglerConfig("mcp"));

  it('keeps PHOTO_AUTOWRITE_ENABLED = "false" until John says otherwise, directly', () => {
    expect(mcpVars.PHOTO_AUTOWRITE_ENABLED).toBe("false");
  });

  it("declares every write gate, so `null` from the reader means a broken binding, not a decision", () => {
    for (const name of WRITE_GATE_NAMES) expect(mcpVars[name]).toBeDefined();
  });
});
