/**
 * OPE-368 (R4) — a refused reply must survive its refusal.
 *
 * On 2026-08-10 an agent told John a reply "was blocked" and neither of them
 * could say why or what had become of the text. The gate returned
 * `disabled:true`, discarded the prose, and wrote nothing anywhere — so the
 * attempt was invisible to the fault ledger, the canaries and the Monday
 * inventory. It surfaced only because a human was in the loop at that moment.
 *
 * These cover the shared behaviour both refusal sites call. The gate still
 * refuses; what changes is that the answer somebody wrote is not destroyed by
 * the refusal.
 */
import { describe, it, expect } from "vitest";
import { buildRefusedReply, refusedReplyMessage } from "@takemetothefair/utils";
import {
  resolveCapabilityFlags,
  darkCapabilityLines,
  CAPABILITY_FLAGS,
} from "../analytics-overview/dark-capabilities";

const NOW = new Date("2026-08-11T18:00:00Z");

describe("buildRefusedReply (OPE-368)", () => {
  it("preserves the body verbatim — the point is that an operator can read it", () => {
    const body = "Hi Katie,\n\nYes — the fair runs both days.\n\nThanks!";
    const rec = buildRefusedReply(
      {
        inboundEmailId: "inb-1",
        toAddress: "katie@example.com",
        subject: "Re: hours",
        bodyText: body,
        requestedBy: "developer-claude-code",
      },
      NOW,
      "draft-1"
    );
    expect(rec.bodyText).toBe(body);
    expect(rec.status).toBe("pending");
    expect(rec.requestedAt).toBe(NOW);
    expect(rec.requestedBy).toBe("developer-claude-code");
  });

  it("trims surrounding whitespace but never truncates", () => {
    const long = "x".repeat(5000);
    const rec = buildRefusedReply(
      {
        inboundEmailId: "i",
        toAddress: "a@b.c",
        subject: null,
        bodyText: `\n\n${long}\n\n`,
        requestedBy: null,
      },
      NOW,
      "d"
    );
    expect(rec.bodyText).toBe(long);
    expect(rec.bodyText).toHaveLength(5000);
  });
});

describe("refusedReplyMessage (OPE-368)", () => {
  it("names the draft id so the refusal can be followed up", () => {
    // The old message said only "disabled". A refusal you cannot follow up on
    // is indistinguishable from a failure — which is exactly how it was
    // reported to John.
    const msg = refusedReplyMessage("draft-abc123");
    expect(msg).toContain("draft-abc123");
    expect(msg).toContain("SAVED");
    expect(msg).toContain("Nothing was sent");
  });
});

describe("dark capability reporting (OPE-368 item 4)", () => {
  it("reports a flag that is off as dark", () => {
    const states = resolveCapabilityFlags({ EMAIL_REPLY_ENABLED: "false" });
    const reply = states.find((s) => s.name === "EMAIL_REPLY_ENABLED");
    expect(reply?.dark).toBe(true);
  });

  it("treats an UNSET flag as dark, not as healthy", () => {
    // The failure mode is a capability nobody knows is off. An unset flag is
    // the most silent version of that, so it must not read as fine.
    const states = resolveCapabilityFlags({});
    expect(states.every((s) => s.dark)).toBe(true);
  });

  it("reads ENRICHMENT_DRY_RUN by the consumer's OWN rule, not a restatement", () => {
    // Production is `env.ENRICHMENT_DRY_RUN !== "false"` (enrichment/
    // select-candidates.ts, promoter-select.ts). So ONLY an explicit "false"
    // means enrichment writes; everything else — including unset, and
    // including the string "true" — is dry-run, i.e. dark.
    //
    // My first implementation used `value === "true"`, which reported an unset
    // flag as LIT: "enrichment is writing" while nothing was. This test caught
    // it. Re-derive the consumer's rule; do not restate it from memory.
    const dry = resolveCapabilityFlags({ ENRICHMENT_DRY_RUN: "true" });
    expect(dry.find((s) => s.name === "ENRICHMENT_DRY_RUN")?.dark).toBe(true);

    const unset = resolveCapabilityFlags({});
    expect(unset.find((s) => s.name === "ENRICHMENT_DRY_RUN")?.dark).toBe(true);

    const live = resolveCapabilityFlags({ ENRICHMENT_DRY_RUN: "false" });
    expect(live.find((s) => s.name === "ENRICHMENT_DRY_RUN")?.dark).toBe(false);
  });

  it("says nothing when every capability is lit", () => {
    const env: Record<string, string> = {};
    for (const f of CAPABILITY_FLAGS)
      env[f.name] = f.name === "ENRICHMENT_DRY_RUN" ? "false" : "true";
    expect(darkCapabilityLines(resolveCapabilityFlags(env))).toHaveLength(0);
  });

  it("distinguishes a deliberate stop-gate from an unnoticed dark flag", () => {
    // Both are dark; only one is a problem. Reporting them identically is how
    // an operator learns to skim the line — and the newsletter flag sat off for
    // weeks precisely because nothing separated 'intended' from 'forgotten'.
    const lines = darkCapabilityLines(
      resolveCapabilityFlags({
        EMAIL_REPLY_ENABLED: "false",
        NEWSLETTER_SEND_ENABLED: "false",
      })
    );
    expect(lines.find((l) => l.startsWith("EMAIL_REPLY_ENABLED"))).toContain("(deliberate)");
    expect(lines.find((l) => l.startsWith("NEWSLETTER_SEND_ENABLED"))).toContain("NOT deliberate");
  });

  it("states what is dark, not just that something is", () => {
    const [line] = darkCapabilityLines(resolveCapabilityFlags({ EMAIL_REPLY_ENABLED: "false" }));
    expect(line).toContain("auto-ack promising a reply");
  });
});
