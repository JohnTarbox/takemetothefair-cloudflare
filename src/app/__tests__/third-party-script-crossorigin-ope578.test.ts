/**
 * OPE-578 — every CROSS-ORIGIN script tag must carry `crossOrigin`.
 *
 * ── What the investigation found ──────────────────────────────────────────
 * OPE-105 ("de-blind client `Script error.`") DID land. Measured on the served
 * HTML 2026-08-28: /login carries 19 scripts with a `src`, 17 with
 * `crossorigin`; /register 21 and 19. Every missing one is third-party.
 *
 * But the attribute was doing nothing for the symptom, because our own bundles
 * are served SAME-ORIGIN from `/_next/static/...` — and for a same-origin
 * script the browser already gives `window.onerror` the real message and
 * stack. `crossorigin` there is belt-and-braces.
 *
 * So `Script error.` on those pages could only ever have come from the two
 * CROSS-origin scripts, which are exactly the two that lacked the attribute:
 * Google Tag Manager and the Cloudflare Insights beacon. Both hosts DO send
 * CORS headers (`https://meetmeatthefair.com` and `*` respectively, verified
 * 2026-08-28), so adding it makes their errors attributable.
 *
 * ── Why a source-level guard ──────────────────────────────────────────────
 * The invariant is about markup that only exists in this one file, and it
 * regresses by someone adding a fourth analytics tag without thinking about
 * it. A rendering test would not catch that any earlier and needs the whole
 * App Router shell.
 *
 * ⚠️ The precondition this guard CANNOT check: `crossOrigin="anonymous"` on a
 * host that stops sending `Access-Control-Allow-Origin` causes the browser to
 * BLOCK the script entirely. Both hosts send it today. Both are analytics, so
 * a regression degrades measurement rather than the site — but if a third-party
 * tag is ever added here for something load-bearing, check its CORS headers
 * before copying this pattern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");

/**
 * Every `<script …/>` ELEMENT whose `src` is an absolute external URL.
 *
 * ⚠️ Anchored on the `src`, then walked outward to the enclosing tag —
 * deliberately, and the first version of this helper is why. Matching
 * `/<script[\s\S]*?\/>/g` looks obvious and is wrong here: this file's own
 * comments discuss `<script>` in prose, so the pattern matched a COMMENT and
 * then ran non-greedily to some later `/>`, swallowing the real tags. Removing
 * `crossOrigin` from the gtag element did not fail the test, and it passed the
 * "did we find anything" check too, because the concatenated blob still
 * mentioned both hostnames.
 *
 * Walking out from a real `src=` cannot match prose, because prose does not
 * contain one.
 */
function externalScriptTags(source: string): string[] {
  const out: string[] = [];
  const srcPattern = /src=(?:"|\{`)https:\/\//g;
  let m: RegExpExecArray | null;
  while ((m = srcPattern.exec(source)) !== null) {
    const open = source.lastIndexOf("<script", m.index);
    const close = source.indexOf("/>", m.index);
    if (open === -1 || close === -1) continue;
    out.push(source.slice(open, close + 2));
  }
  return out;
}

describe("third-party script tags in the root layout", () => {
  it("finds the external tags at all — guards against a vacuous pass", () => {
    // Without this the suite goes green by matching nothing, which is exactly
    // how a source-level assertion rots into decoration.
    const tags = externalScriptTags(layout);
    expect(tags.length).toBeGreaterThanOrEqual(2);
    // Asserted PER TAG rather than on the joined blob. The joined form passed
    // while the helper was matching one giant comment-spanning blob that
    // happened to contain both hostnames — an anti-vacuity check that was
    // itself vacuous.
    expect(tags.some((t) => t.includes("googletagmanager.com"))).toBe(true);
    expect(tags.some((t) => t.includes("cloudflareinsights.com"))).toBe(true);
    // Each match must be ONE element, not a span across several.
    for (const tag of tags) {
      expect(tag.match(/<script/g)?.length ?? 0).toBe(1);
    }
  });

  it("every external script carries crossOrigin — the OPE-578 fix", () => {
    for (const tag of externalScriptTags(layout)) {
      const src = /src=.*?(https:\/\/[^`"'}\s]+)/.exec(tag)?.[1] ?? tag.slice(0, 60);
      expect(tag, `external script without crossOrigin: ${src}`).toMatch(/crossOrigin/);
    }
  });

  it("does not require crossOrigin on same-origin bundles", () => {
    // Stated so the rule is not over-applied later: Next.js emits the
    // /_next/static tags itself, they are same-origin, and the browser already
    // reports their errors in full. This test asserts the SCOPE of the rule.
    const relative = (layout.match(/<script[\s\S]*?\/>/g) ?? []).filter((t) =>
      /src="\/(?!\/)/.test(t)
    );
    for (const tag of relative) {
      expect(tag).not.toMatch(/crossOrigin/);
    }
  });
});
