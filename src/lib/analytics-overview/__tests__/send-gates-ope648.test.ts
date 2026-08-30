/**
 * OPE-648 — the send-gate reader.
 *
 * The rule an agent is given is: check `EMAIL_REPLY_ENABLED` before replying to
 * a customer, and DO NOT test it by sending. Until this shipped that rule was
 * unfollowable — `workers_get_worker` returns name and id only, and nothing
 * reported gate state — so the only available check was the prohibited one. On
 * 2026-08-30 an agent followed the rule, had no way to comply, sent, and learned
 * the state from the refusal.
 *
 * The security-relevant property is the ALLOWLIST: this reader takes no key, so
 * there is no arbitrary env value to request. The tests below pin that, and pin
 * the two ways a reader can be worse than nothing — reporting "off" for a gate
 * it cannot see, and treating the string "false" as on.
 */
import { describe, it, expect } from "vitest";
import { resolveSendGates, SEND_GATE_NAMES, type SendGateName } from "../dark-capabilities";

const get = (
  env: Record<string, string | undefined>,
  worker: "main-app" | "mcp",
  name: SendGateName
) => resolveSendGates(env, worker).find((g) => g.name === name)!;

describe("reports the resolved value of every allowlisted gate", () => {
  it("covers exactly the four send gates, no more", () => {
    expect([...SEND_GATE_NAMES]).toEqual([
      "EMAIL_REPLY_ENABLED",
      "OPERATOR_OUTBOUND_ENABLED",
      "NEWSLETTER_SEND_ENABLED",
      "VENDOR_DIGEST_SEND_ENABLED",
    ]);
    expect(resolveSendGates({}, "main-app")).toHaveLength(4);
  });

  it("reads EMAIL_REPLY_ENABLED on the main app — it is enforced on BOTH workers", () => {
    // The inventory previously listed this as mcp-only, so the main-app reader
    // returned null for a flag it can read. Both wrangler.tomls declare it.
    const g = get({ EMAIL_REPLY_ENABLED: "true" }, "main-app", "EMAIL_REPLY_ENABLED");
    expect(g.readable_here).toBe(true);
    expect(g.enabled).toBe(true);
    expect(g.enforced_on).toEqual(["main-app", "mcp"]);
  });
});

describe("the two ways a reader is worse than no reader", () => {
  it("does NOT report a gate it cannot see as OFF", () => {
    // "Absent from my env" and "off" are different claims. OPERATOR_OUTBOUND is
    // enforced only on the MCP Worker.
    const g = get({}, "main-app", "OPERATOR_OUTBOUND_ENABLED");
    expect(g.readable_here).toBe(false);
    expect(g.enabled).toBeNull();
    expect(g.enabled).not.toBe(false);
  });

  it('treats the STRING "false" as off, not as truthy', () => {
    // The most expensive possible way to misread a kill switch.
    expect(get({ EMAIL_REPLY_ENABLED: "false" }, "main-app", "EMAIL_REPLY_ENABLED").enabled).toBe(
      false
    );
    for (const v of ["FALSE", "1", "yes", "True", " true", ""]) {
      expect(get({ EMAIL_REPLY_ENABLED: v }, "main-app", "EMAIL_REPLY_ENABLED").enabled).toBe(
        false
      );
    }
  });

  it("reports an unset gate as off, with the raw value null", () => {
    const g = get({}, "main-app", "NEWSLETTER_SEND_ENABLED");
    expect(g.value).toBeNull();
    expect(g.enabled).toBe(false); // readable here, and unset means off
  });
});

describe("the allowlist is the security boundary", () => {
  it("exposes no other env value, whatever else is in env", () => {
    const env = {
      EMAIL_REPLY_ENABLED: "true",
      INTERNAL_API_KEY: "super-secret",
      RESEND_API_KEY: "re_live_abc123",
      SC_SITE_URL: "https://meetmeatthefair.com/",
    };
    const serialized = JSON.stringify(resolveSendGates(env, "main-app"));
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("re_live_abc123");
    expect(serialized).not.toContain("INTERNAL_API_KEY");
    // And nothing outside the allowlist appears at all.
    for (const g of resolveSendGates(env, "main-app")) {
      expect(SEND_GATE_NAMES).toContain(g.name);
    }
  });

  it("has no key parameter to abuse — the signature only takes env + worker", () => {
    // A generic get_env(key) would satisfy the ticket's need and be an
    // exfiltration tool. resolveSendGates cannot be asked for anything.
    expect(resolveSendGates.length).toBe(2);
  });
});
