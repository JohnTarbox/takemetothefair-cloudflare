/**
 * OPE-867 (09-23 bounce) — the vendor-digest HTML passed through send_test_email
 * carried a DEAD `<a href="#">Unsubscribe</a>`. It matched neither unsubscribe
 * route, so the wrapper judged the body non-compliant and appended a SECOND,
 * contradictory consent claim beside the dead link — and the text part carried
 * neither the body's reason line nor its link. Specimen: ledger rows
 * 2026-09-14 13:25:17 and 2026-09-21 11:50:13 (`source='email:test'`).
 */
import { describe, it, expect } from "vitest";
import {
  applyCanSpamFooter,
  consentLineOf,
  wireDeadUnsubscribeAnchors,
} from "../src/tools/admin-send-vendor-email";

/** The digest's footer, as sent on 09-21 (from the ledger). */
const DIGEST = `<!doctype html><html><body><table><tr><td>Shows open this week…</td></tr>
<tr><td>You're receiving this because you signed up for vendor show alerts.<br>
  <a href="https://meetmeatthefair.com" style="color:#9a968c;">Visit the site</a> &nbsp;&middot;&nbsp;
  <a href="#" style="color:#9a968c;text-decoration:underline;">Unsubscribe</a></td></tr></table>
</body></html>`;

const REASON = "this is a deliverability test you triggered from Meet Me at the Fair.";
const send = () =>
  applyCanSpamFooter(
    { subject: "[TEST] Shows Now Open for Vendors", text: "Shows open this week…", html: DIGEST },
    {
      recipientEmail: "jtarboxme@gmail.com",
      reasonLine: REASON,
      env: { UNSUBSCRIBE_SECRET: "s" } as never,
    }
  );

describe("OPE-867 — a dead Unsubscribe anchor in a caller's HTML", () => {
  it('ACCEPTANCE: no href="#" survives; the anchor points at the real one-click URL', async () => {
    const out = await send();
    expect(out.html).not.toContain('href="#"');
    const links = out.html.match(/<a[^>]*>\s*Unsubscribe\s*<\/a>/gi) ?? [];
    expect(links).toHaveLength(1); // wired, not duplicated
    expect(links[0]).toMatch(/\/unsubscribe\//);
  });

  it("exactly ONE consent claim — the wrapper adds a Note, not a rival reason", async () => {
    const out = await send();
    expect(out.html.match(/receiving this because/gi)).toHaveLength(1);
    expect(out.html).toContain(`Note: ${REASON.replace(/'/g, "&#39;")}`.slice(0, 20));
  });

  it("the text part says what the HTML says: the body's reason line and a working link", async () => {
    const out = await send();
    expect(out.text).toContain(
      "You're receiving this because you signed up for vendor show alerts."
    );
    expect(out.text).toMatch(/Unsubscribe: https:\/\/meetmeatthefair\.com\/unsubscribe\//);
    expect(out.text).toContain(`Note: ${REASON}`);
  });

  it("a live anchor and ordinary links are left alone", () => {
    const live = `<a href="https://meetmeatthefair.com/unsubscribe/v2/abc">Unsubscribe</a> <a href="#top">Back to top</a>`;
    expect(wireDeadUnsubscribeAnchors(live, "https://x/unsubscribe/v2/zzz")).toBe(live);
  });

  it("wires placeholder hrefs too", () => {
    for (const h of ['""', '"{{unsubscribe_url}}"', '"[UNSUB]"', '"%UNSUBSCRIBE%"']) {
      const out = wireDeadUnsubscribeAnchors(
        `<a href=${h}>Unsubscribe</a>`,
        "https://x/unsubscribe/v2/z"
      );
      expect(out).toBe('<a href="https://x/unsubscribe/v2/z">Unsubscribe</a>');
    }
  });

  it("consentLineOf reads the body's reason", () => {
    expect(consentLineOf(DIGEST)).toBe("you signed up for vendor show alerts.");
    expect(consentLineOf("<p>no footer</p>")).toBeNull();
  });
});
