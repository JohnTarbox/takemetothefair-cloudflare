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
import { readWranglerConfig, wranglerVars } from "../../scripts/lib/wrangler-config";
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

  it("covers exactly the allowlisted gates and takes no key parameter", async () => {
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
  // OPE-1292 — parsed: "declared" means in the top-level [vars] table.
  const mcpVars = wranglerVars(readWranglerConfig("mcp"));

  it("declares OPERATOR_OUTBOUND_ENABLED in mcp-server/wrangler.toml", () => {
    // Committed, not dashboard: a dashboard [vars] value is wiped wholesale by
    // the next `wrangler deploy` (OPE-284/OPE-509).
    expect(mcpVars).toHaveProperty("OPERATOR_OUTBOUND_ENABLED");
  });

  it('has it committed as "true" — turned on by John (OPE-596, 2026-10-05)', () => {
    // ⚠️ Kept, not deleted, and it must stay able to FAIL. It pinned "false"
    // until John's ruling (OPE-596: approved 10-04, "turn on
    // OPERATOR_OUTBOUND_ENABLED" in session 10-05), and this edit IS the
    // reviewed flip it was written to force. It now pins "true", so a silent
    // flip back OFF is noticed the same way. Delivery still needs a human
    // approve on each draft (review_operator_draft).
    expect(mcpVars).toHaveProperty("OPERATOR_OUTBOUND_ENABLED");
    expect(mcpVars.OPERATOR_OUTBOUND_ENABLED).toBe("true");
  });
});

/**
 * OPE-772 rework (2026-09-16) — four send gates this reader could not see, and
 * one of them is OPEN when unset. The resolver must mirror each gate's real
 * comparison, so the last block reads the consumers' own source rather than
 * restating their semantics from memory.
 */
describe("OPE-772 rework — the gates the reader was missing", () => {
  it("reads PROMOTER_OUTREACH_ENABLED here — the gate holding the outreach rail shut", async () => {
    const g = byName(
      (await gates({ PROMOTER_OUTREACH_ENABLED: "false" })).gates,
      "PROMOTER_OUTREACH_ENABLED"
    );
    expect(g).toMatchObject({
      readable_here: true,
      value: "false",
      enabled: false,
      enforced_on: ["mcp"],
    });
  });

  it("reports AUTO_REPLY_ENABLED as ENABLED when unset — it is default-open, and the acks ARE going out", async () => {
    const out = await gates({});
    const g = byName(out.gates, "AUTO_REPLY_ENABLED") as Gate & { unset_means: string };
    expect(g.value).toBeNull();
    expect(g.enabled).toBe(true);
    expect(g.unset_means).toBe("enabled");
    // Still named as unset — a missing binding is worth seeing even when harmless.
    expect(out.unset_but_enforced_here).toContain("AUTO_REPLY_ENABLED");
  });

  it('holds AUTO_REPLY_ENABLED only on the exact string "false"', async () => {
    expect(
      byName((await gates({ AUTO_REPLY_ENABLED: "false" })).gates, "AUTO_REPLY_ENABLED").enabled
    ).toBe(false);
    expect(
      byName((await gates({ AUTO_REPLY_ENABLED: "true" })).gates, "AUTO_REPLY_ENABLED").enabled
    ).toBe(true);
  });

  it("does not answer for SUBMISSION_ACK_ENABLED, a main-app gate", async () => {
    const g = byName(
      (await gates({ SUBMISSION_ACK_ENABLED: "true" })).gates,
      "SUBMISSION_ACK_ENABLED"
    );
    expect(g.readable_here).toBe(false);
    expect(g.enabled).toBeNull();
  });

  it("every allowlisted gate is declared in the committed wrangler.toml of each Worker that enforces it", async () => {
    const mcpDeclared = wranglerVars(readWranglerConfig("mcp"));
    const appDeclared = wranglerVars(readWranglerConfig("main"));
    const out = await gates({});
    // Positive landmark: the loop really covered every gate.
    expect(out.gates).toHaveLength(SEND_GATE_NAMES.length);
    for (const g of out.gates) {
      if (g.enforced_on.includes("mcp"))
        expect(mcpDeclared, `${g.name} in mcp-server/wrangler.toml [vars]`).toHaveProperty(g.name);
      if (g.enforced_on.includes("main-app"))
        expect(appDeclared, `${g.name} in wrangler.toml [vars]`).toHaveProperty(g.name);
    }
  });

  it("each gate's unset_means matches the comparison its SEND SITE actually uses", async () => {
    const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    const consumers: Array<[string, string, RegExp]> = [
      ["AUTO_REPLY_ENABLED", "src/email-gates.ts", /AUTO_REPLY_ENABLED\s*!==\s*"false"/],
      [
        "PROMOTER_OUTREACH_ENABLED",
        "src/tools/admin-send-promoter-email.ts",
        /PROMOTER_OUTREACH_ENABLED\s*===\s*"true"/,
      ],
      [
        "UNROUTED_ASK_ENABLED",
        "src/workflows/inbound-email.ts",
        /UNROUTED_ASK_ENABLED\s*===\s*"true"/,
      ],
      [
        "SUBMISSION_ACK_ENABLED",
        "../src/lib/email/submission-received.ts",
        /SUBMISSION_ACK_ENABLED\s*!==\s*"true"/,
      ],
    ];
    const out = await gates({});
    for (const [name, file, pattern] of consumers) {
      expect(src(file), `${name}'s comparison in ${file}`).toMatch(pattern);
      const unsetMeans = (byName(out.gates, name) as Gate & { unset_means: string }).unset_means;
      // `!== "false"` is open-when-unset; `=== "true"` / `!== "true"` → skip are closed.
      expect(unsetMeans, name).toBe(
        pattern.source.includes('!==\\s*"false"') ? "enabled" : "disabled"
      );
    }
  });
});
