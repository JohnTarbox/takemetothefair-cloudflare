/**
 * OPE-772 — `get_send_gates` on the MCP surface, and the flag it exists to read.
 *
 * OPE-648 shipped the reader and exposed it at the main app's
 * /api/admin/capability-flags. The hole it left is specific and was found the
 * hard way: `OPERATOR_OUTBOUND_ENABLED` is enforced on the MCP Worker ONLY, so
 * the app reader answers `enabled: null` for it — correctly, and uselessly. The
 * one gate an operator went looking for was the one gate no exposed reader
 * could speak for.
 *
 * Two things are therefore under test: that this Worker can answer for its own
 * gates, and that the flag is actually declared in the committed config. The
 * second matters as much as the first — an unset binding and "false" behave
 * identically at the send site, so a reader that reports "off" for a flag that
 * was never provisioned is reporting a broken read as a decision.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapturingMcpServer } from "./setup-db.js";
import { registerSendGatesTool } from "../src/tools/admin-send-gates.js";
import { SEND_GATE_NAMES } from "@takemetothefair/constants";

const ADMIN = { role: "ADMIN", userId: "admin-1" } as never;
const NON_ADMIN = { role: "VENDOR", userId: "v-1" } as never;

type Gate = {
  name: string;
  value: string | null;
  enabled: boolean | null;
  readable_here: boolean;
  enforced_on: string[];
};

async function gates(env: Record<string, string | undefined>) {
  const s = new CapturingMcpServer();
  registerSendGatesTool(s as never, {} as never, ADMIN, env);
  const res = (await s.invoke("get_send_gates", {})) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text) as {
    worker: string;
    gates: Gate[];
    unset_but_enforced_here: string[];
  };
}
const byName = (g: Gate[], n: string) => g.find((x) => x.name === n)!;

describe("get_send_gates — the gate only this Worker can answer for (OPE-772)", () => {
  it("reports OPERATOR_OUTBOUND_ENABLED as readable here, which the app reader cannot", async () => {
    const out = await gates({ OPERATOR_OUTBOUND_ENABLED: "false" });
    const g = byName(out.gates, "OPERATOR_OUTBOUND_ENABLED");
    expect(g.readable_here).toBe(true);
    expect(g.value).toBe("false");
    expect(g.enabled).toBe(false);
    expect(g.enforced_on).toEqual(["mcp"]);
  });

  it("distinguishes UNSET-but-enforced-here from off — the broken-read case", async () => {
    // This is the state OPE-772 was filed from: the binding did not exist, and
    // `=== "true"` made it indistinguishable from a deliberate "false".
    const out = await gates({});
    const g = byName(out.gates, "OPERATOR_OUTBOUND_ENABLED");
    expect(g.value).toBeNull();
    expect(out.unset_but_enforced_here).toContain("OPERATOR_OUTBOUND_ENABLED");

    const provisioned = await gates({ OPERATOR_OUTBOUND_ENABLED: "false" });
    expect(provisioned.unset_but_enforced_here).not.toContain("OPERATOR_OUTBOUND_ENABLED");
  });

  it("does NOT claim to speak for a gate this Worker does not enforce", async () => {
    // NEWSLETTER_SEND_ENABLED is a main-app gate. Answering "false" for it here
    // would be the reader being worse than no reader.
    const out = await gates({ NEWSLETTER_SEND_ENABLED: "true" });
    const g = byName(out.gates, "NEWSLETTER_SEND_ENABLED");
    expect(g.readable_here).toBe(false);
    expect(g.enabled).toBeNull();
    expect(g.enabled).not.toBe(false);
  });

  it('treats the STRING "false" as off, not as truthy', async () => {
    const out = await gates({ EMAIL_REPLY_ENABLED: "false" });
    expect(byName(out.gates, "EMAIL_REPLY_ENABLED").enabled).toBe(false);
  });

  it("covers exactly the four allowlisted gates and takes no key parameter", async () => {
    const out = await gates({});
    expect(out.gates.map((g) => g.name)).toEqual([...SEND_GATE_NAMES]);
    // The security property: nothing to pass, so nothing to abuse. If a `key`
    // argument is ever added, this fails and the reviewer has to justify it.
    const s = new CapturingMcpServer();
    registerSendGatesTool(s as never, {} as never, ADMIN, {});
    expect(Object.keys(s.schemas.get("get_send_gates") ?? {})).toEqual([]);
  });

  it("is not registered for a non-admin", () => {
    const s = new CapturingMcpServer();
    registerSendGatesTool(s as never, {} as never, NON_ADMIN, {});
    expect(s.handlers.has("get_send_gates")).toBe(false);
  });
});

describe("OPE-772 — the flag is declared in the committed config", () => {
  // mcp-server/__tests__ runs with cwd = mcp-server.
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");

  it("declares OPERATOR_OUTBOUND_ENABLED in mcp-server/wrangler.toml", () => {
    // Committed, not dashboard: a dashboard [vars] value is wiped wholesale by
    // the next `wrangler deploy` (OPE-284/OPE-509).
    expect(toml).toMatch(/^OPERATOR_OUTBOUND_ENABLED\s*=/m);
  });

  it('has it committed as "false" — OPE-772 provisions the flag, it does not enable it', () => {
    // ⚠️ Kept, not deleted, and it must stay able to FAIL. When John decides to
    // turn delivery on, flipping the value fails this test — which is the point:
    // the flip becomes a reviewed edit rather than a drive-by, and this is also
    // the only thing that would notice a silent flip.
    expect(toml).toMatch(/^OPERATOR_OUTBOUND_ENABLED\s*=\s*"false"/m);
  });
});
