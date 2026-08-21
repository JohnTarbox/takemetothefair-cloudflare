/**
 * OPE-509 — the gate reporter must not lie about what it cannot see.
 *
 * The flags live on two separate Workers. This route runs in the main app, so
 * the MCP's flags are simply absent from its env — and `resolveCapabilityFlags`
 * scores an absent flag as DARK. Reporting the MCP's live capabilities as dark
 * because we cannot read them would be worse than reporting nothing at all.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAGS,
  resolveCapabilityFlags,
} from "@/lib/analytics-overview/dark-capabilities";

const mainApp = CAPABILITY_FLAGS.filter((f) => f.worker === "main-app");
const mcp = CAPABILITY_FLAGS.filter((f) => f.worker !== "main-app");

describe("capability-flags surface (OPE-509)", () => {
  it("both partitions are non-empty — otherwise the split is silently a no-op", () => {
    expect(mainApp.length).toBeGreaterThan(0);
    expect(mcp.length).toBeGreaterThan(0);
  });

  it("resolves main-app flags from the main-app env", () => {
    const states = resolveCapabilityFlags({ NEWSLETTER_SEND_ENABLED: "true" }, mainApp);
    const n = states.find((s) => s.name === "NEWSLETTER_SEND_ENABLED");
    expect(n?.value).toBe("true");
    expect(n?.dark).toBe(false);
  });

  it("THE TRAP: resolving an MCP flag against main-app env reports it dark", () => {
    // This is why the route must not simply resolve every flag. Pinning the
    // behaviour so the reason for the partition cannot be optimised away.
    const states = resolveCapabilityFlags({}, mcp);
    expect(states.every((s) => s.dark)).toBe(true);
    expect(states.every((s) => s.value === null)).toBe(true);
  });

  it("NEWSLETTER_SEND_ENABLED is in the main-app partition, not the MCP one", () => {
    // It is configured on meetmeatthefair-app; filing it under mcp would make
    // the endpoint permanently unable to answer its own headline question.
    expect(mainApp.map((f) => f.name)).toContain("NEWSLETTER_SEND_ENABLED");
    expect(mcp.map((f) => f.name)).not.toContain("NEWSLETTER_SEND_ENABLED");
  });

  it("every inventoried flag carries an operator-readable darkMeans", () => {
    for (const f of CAPABILITY_FLAGS) {
      expect(f.darkMeans.length).toBeGreaterThan(20);
    }
  });

  it("SUBMISSION_ACK_ENABLED is inventoried — it withholds from a real person", () => {
    expect(CAPABILITY_FLAGS.map((f) => f.name)).toContain("SUBMISSION_ACK_ENABLED");
  });
});
