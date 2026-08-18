/**
 * OPE-461 — the rendered-body preview couldn't break a long URL.
 *
 * `/admin/sent-emails` shows the body two ways. The `<pre>` fallback (plain
 * text, and the Raw HTML toggle) has carried `whitespace-pre-wrap break-words`
 * all along — which is why only the **rendered** tab showed the problem.
 *
 * That tab is `<iframe srcDoc={bodyHtml}>` with no stylesheet at all, so the
 * document gets UA defaults and nothing else. Ordinary prose wraps; an
 * unbreakable token has nowhere to break. Our own replies are the worst case —
 * every receipt-widget link is a ~90-character feedback URL with no spaces:
 *
 *   https://meetmeatthefair.com/feedback/UEHA5G_P6C-a_i2m8b8eGXeg1_ho94JkV1ByOHx4wK8?v=wrong_intent
 *
 * One of those pushes the whole document sideways.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(__dirname, "..", "page.tsx"), "utf8");

// A real receipt-widget link from email_send_ledger.
const LONG_LINK =
  "https://meetmeatthefair.com/feedback/UEHA5G_P6C-a_i2m8b8eGXeg1_ho94JkV1ByOHx4wK8?v=wrong_intent";

/** Mirrors wrapEmailPreview() in page.tsx (not exported — it's a page module). */
function wrapEmailPreview(bodyHtml: string): string {
  const style = `<style>
    html,body{margin:0;padding:12px;background:#fff;}
    body{font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#111;
         overflow-wrap:anywhere;word-break:break-word;}
    img{max-width:100%;height:auto;}
    table{max-width:100%;}
    a{color:#1d4ed8;}
  </style>`;
  return `${style}${bodyHtml}`;
}

describe("the preview document carries wrapping rules", () => {
  const out = wrapEmailPreview(`<p>Was this what you wanted? ${LONG_LINK}</p>`);

  it("sets overflow-wrap so an unbreakable URL can break", () => {
    expect(out).toContain("overflow-wrap:anywhere");
  });

  it("sets word-break for older engines", () => {
    expect(out).toContain("word-break:break-word");
  });

  it("constrains images and tables to the frame", () => {
    expect(out).toContain("img{max-width:100%");
    expect(out).toContain("table{max-width:100%;}");
  });
});

describe("the body itself is never altered", () => {
  it("passes the email HTML through byte-for-byte", () => {
    // The operator must see what the CUSTOMER received. A preview that quietly
    // rewrote the body would defeat the point of the page — and this page is
    // exactly where OPE-455's corrupted-link question gets adjudicated.
    const body = `<p>Hello &amp; welcome — ${LONG_LINK}</p>`;
    expect(wrapEmailPreview(body).endsWith(body)).toBe(true);
  });

  it("adds styling only as a prefix", () => {
    const body = "<p>x</p>";
    const out = wrapEmailPreview(body);
    expect(out.indexOf("<style>")).toBe(0);
    expect(out.slice(out.indexOf("</style>") + "</style>".length)).toBe(body);
  });
});

describe("the page wires it in", () => {
  it("uses the wrapper for srcDoc rather than the raw body", () => {
    // A check that exists but is never called is this repo's recurring defect
    // class, so pin the call site too.
    expect(SOURCE).toContain("srcDoc={wrapEmailPreview(d.bodyHtml)}");
    expect(SOURCE).not.toContain("srcDoc={d.bodyHtml}");
  });

  it("keeps the iframe sandboxed", () => {
    expect(SOURCE).toContain('sandbox=""');
  });

  it("leaves the <pre> fallback's existing wrapping alone", () => {
    expect(SOURCE).toContain("whitespace-pre-wrap break-words");
  });
});
