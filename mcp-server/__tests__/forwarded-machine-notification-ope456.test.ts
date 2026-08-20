/**
 * OPE-456 scope 1b — never auto-answer a machine notification inside a forward.
 *
 * The specimen: Google Search Console mailed `sc-noreply@google.com`, John
 * forwarded it to submit@, and the pipeline replied "We couldn't find a link to
 * the event in your message" — to Search Console. The envelope guard could not
 * see it, because the envelope sender was John.
 */
import { describe, it, expect } from "vitest";
import { detectForwardedMachineNotification } from "../src/email-handlers/forwarded-machine-notification.js";

const GSC_FORWARD = `---------- Forwarded message ---------
From: Google Search Console <sc-noreply@google.com>
Date: Sun, 17 Aug 2026 at 06:03
Subject: Congrats on reaching 12K clicks in 28 days!
To: <jtarboxme@gmail.com>

On Aug 15, 2026 your site meetmeatthefair.com reached 12K clicks in 28 days.`;

describe("the OPE-456 specimen", () => {
  it("detects the machine original behind a human forward", () => {
    const r = detectForwardedMachineNotification(GSC_FORWARD);
    expect(r.isMachine).toBe(true);
    expect(r.originalSender).toBe("sc-noreply@google.com");
  });

  it("catches a vendor-prefixed robot, not just bare noreply@", () => {
    // `sc-noreply` is why a plain equality check on the local part fails.
    expect(detectForwardedMachineNotification("From: sc-noreply@google.com").isMachine).toBe(true);
    expect(detectForwardedMachineNotification("From: noreply@example.com").isMachine).toBe(true);
    expect(detectForwardedMachineNotification("From: no-reply@example.com").isMachine).toBe(true);
    expect(detectForwardedMachineNotification("From: mailer-daemon@example.com").isMachine).toBe(
      true
    );
  });

  it("reads a quoted forward header", () => {
    const body = `> From: "Search Console" <sc-noreply@google.com>\n> Subject: Congrats`;
    expect(detectForwardedMachineNotification(body).originalSender).toBe("sc-noreply@google.com");
  });
});

describe("does not suppress a real person's mail", () => {
  it("an ordinary forwarded submission from a human", () => {
    const body = `---------- Forwarded message ---------
From: Kristin McDowell <recreation@belgrademaine.gov>
Subject: Artisan Fair

I am attaching the list for Saturday's Fair.`;
    expect(detectForwardedMachineNotification(body).isMachine).toBe(false);
  });

  it("a human whose address merely CONTAINS the word noreply", () => {
    // The same false-positive audit-sender guards against.
    expect(detectForwardedMachineNotification("From: noreplyfan@example.com").isMachine).toBe(
      false
    );
    expect(detectForwardedMachineNotification("From: benoreply@example.com").isMachine).toBe(false);
  });

  it("an address mentioned in PROSE is not a forwarded header", () => {
    const body = "Please cc sc-noreply@google.com if you need the original.";
    expect(detectForwardedMachineNotification(body).isMachine).toBe(false);
  });

  it("empty and null bodies are safe", () => {
    expect(detectForwardedMachineNotification(null).isMachine).toBe(false);
    expect(detectForwardedMachineNotification("").isMachine).toBe(false);
  });
});

/**
 * Source-level: the guard must read the FULL body. The forwarded `From:` header
 * routinely sits past the 500-character `body_text_excerpt` preview, so reading
 * the excerpt would make the guard silently never fire — the exact trap OPE-459
 * documented on the multi-source URL path.
 */
describe("the guard reads the full body", () => {
  it("send-reply selects bodyText, not bodyTextExcerpt, for the guard", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/workflows/inbound-email.ts", import.meta.url), "utf8");
    const call = src.indexOf("detectForwardedMachineNotification(rows[0].");
    expect(call).toBeGreaterThan(-1);
    expect(src.slice(call, call + 90)).toContain("rows[0].bodyText");
    expect(src.slice(call, call + 90)).not.toContain("bodyTextExcerpt");
  });
});
