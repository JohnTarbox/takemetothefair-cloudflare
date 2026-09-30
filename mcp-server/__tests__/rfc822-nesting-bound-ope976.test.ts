/**
 * OPE-976 — inline `message/rfc822` nesting is BOUNDED on every parse path.
 *
 * submit@ is public and unauthenticated. On postal-mime 2.7.4 each nested
 * rfc822 level built a fresh parser with a fresh depth budget, so a 257 KB
 * message of 2,000 layers cost ~120 s of Worker CPU and still reached the
 * innermost payload. These tests pin three things:
 *
 *  1. the installed library, called with OUR options, stops descending;
 *  2. `analyzeForward` does not reopen a part the library refused (which would
 *     restart the recursion with a fresh budget);
 *  3. every `PostalMime.parse` in the Worker passes our options at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import {
  analyzeForward,
  POSTAL_MIME_OPTIONS,
  RFC822_MAX_NESTING_DEPTH,
} from "../src/email-handlers/forwarded-message.js";
import { extractSenderSignals } from "../src/email-handler.js";

const CRLF = "\r\n";
const SENTINEL = "PAYLOAD-SENTINEL-OPE976";

/** `depth` inline rfc822 layers (no Content-Disposition) around a trivial payload. */
function nestedMessage(depth: number): string {
  let msg = ["From: inner@example.com", "Subject: innermost", "", SENTINEL, ""].join(CRLF);
  for (let i = 0; i < depth; i++) {
    const b = `B${i}`;
    msg = [
      `From: layer${i}@example.com`,
      `Subject: layer ${i}`,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain",
      "",
      "x",
      `--${b}`,
      "Content-Type: message/rfc822",
      "",
      msg,
      `--${b}--`,
      "",
    ].join(CRLF);
  }
  return msg;
}

describe("OPE-976 — the fixture is real (positive control)", () => {
  it("a message nested AT the cap still reaches its payload", async () => {
    // Without this, "payload not reached" below could be a parse error on a
    // malformed fixture rather than the bound doing its job. (On postal-mime
    // 2.7.4 the depth-250 fixture below DOES reach the payload, in ~2 s —
    // measured when this test was written.)
    const p = await PostalMime.parse(nestedMessage(RFC822_MAX_NESTING_DEPTH), POSTAL_MIME_OPTIONS);
    expect(p.text ?? "").toContain(SENTINEL);
    expect(p.attachments.some((a) => a.rfc822DepthExceeded)).toBe(false);
  });
});

describe("OPE-976 — deep nesting is refused, fast", () => {
  // Budgets are loose on purpose: a bounded parse is ~(cap+1)× a flat parse
  // (depth 250 ≈ 45 ms locally, depth 2000 / 374 KB ≈ 460 ms), while 2.7.4 took
  // ~2 s at 250 and ~120 s at 2000. The ceiling only has to separate those.
  for (const [depth, budgetMs] of [
    [250, 1000],
    [2000, 5000],
  ] as const) {
    it(`depth ${depth}: stops at the cap, never reaches the payload, under ${budgetMs} ms`, async () => {
      const raw = nestedMessage(depth);
      const t0 = performance.now();
      const p = await PostalMime.parse(raw, POSTAL_MIME_OPTIONS);
      const ms = performance.now() - t0;

      expect(p.text ?? "").not.toContain(SENTINEL);
      // Positive landmark: the library REPORTS that it stopped, so the absence
      // of the payload is the cap and not a silent drop.
      expect(p.attachments.filter((a) => a.rfc822DepthExceeded)).toHaveLength(1);
      // The cap is ours, not the library default: exactly our depth of layer
      // bodies were merged into `.text` (one "x" per opened layer, plus the
      // outermost).
      expect((p.text ?? "").match(/^x$/gm)?.length).toBe(RFC822_MAX_NESTING_DEPTH + 1);
      expect(ms).toBeLessThan(budgetMs);
    });
  }
});

describe("OPE-976 — analyzeForward does not reopen a refused part", () => {
  it("a depth-capped rfc822 attachment is not parsed again with a fresh budget", async () => {
    const p = await PostalMime.parse(nestedMessage(250), POSTAL_MIME_OPTIONS);
    const capped = p.attachments.filter((a) => a.rfc822DepthExceeded);
    expect(capped).toHaveLength(1); // landmark: there IS a candidate to refuse

    const result = await analyzeForward({ attachments: p.attachments, bodyText: p.text });
    expect(result.nested).toBeNull();
    expect(result.kind).not.toBe("rfc822_attachment");
  });

  it("an ordinary attached forward is still opened (the skip is not a blanket refusal)", async () => {
    const inner = ["From: organizer@example.org", "Subject: hi", "", SENTINEL, ""].join(CRLF);
    const result = await analyzeForward({
      attachments: [{ filename: "fwd.eml", mimeType: "message/rfc822", content: inner }],
      bodyText: "fyi",
    });
    expect(result.kind).toBe("rfc822_attachment");
    expect(result.nested?.text ?? "").toContain(SENTINEL);
  });
});

describe("OPE-976 — 3.0.0's breaking header changes, pinned where we read them", () => {
  it("a duplicated From: resolves FIRST-wins (2.7.4 was last-wins — a spoof shape)", async () => {
    const raw = ["From: Real <real@org.com>", "From: Spoof <spoof@evil.com>", "", "x", ""].join(
      CRLF
    );
    const p = await PostalMime.parse(raw, POSTAL_MIME_OPTIONS);
    expect(p.from?.address).toBe("real@org.com");
  });

  it("a FOLDED Received header still yields the origin host (the regex spans the fold)", async () => {
    const raw = [
      "Received: from PH0PR09MB11424.namprd09.prod.outlook.com",
      "\t([fe80::1234]) by PH0PR09MB11424.namprd09.prod.outlook.com",
      "  with mapi id 15.20.8000.000; Thu, 10 Sep 2026 16:04:00 +0000",
      "From: a@b.com",
      "",
      "x",
      "",
    ].join(CRLF);
    const p = await PostalMime.parse(raw, POSTAL_MIME_OPTIONS);
    // Landmark: 3.0.0 really does keep the fold whitespace, so this test is
    // exercising the changed shape and not a pre-collapsed value.
    expect(p.headers.find((h) => h.key === "received")?.value).toMatch(/\s{2,}|\t/);
    const signals = extractSenderSignals(undefined, p);
    expect(signals.sendingHost).toBe("ph0pr09mb11424.namprd09.prod.outlook.com");
  });
});

describe("OPE-976 — every PostalMime.parse in the Worker passes our options", () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
    });
  }

  it("no call site parses with the library defaults", () => {
    const srcDir = join(__dirname, "..", "src");
    const calls: { file: string; call: string }[] = [];
    for (const file of tsFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      // Anchor on the CALL syntax, so the import line and prose mentions of
      // "PostalMime.parse" in comments (no opening paren) do not count.
      for (const m of text.matchAll(/PostalMime\.parse\(([^)]*)\)/g)) {
        calls.push({ file: file.slice(srcDir.length + 1), call: m[0] });
      }
    }
    // Landmark: both known call sites were found, so a matcher that silently
    // stops matching cannot report a clean bill of health.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const unbounded = calls.filter((c) => !c.call.includes("POSTAL_MIME_OPTIONS"));
    expect(unbounded).toEqual([]);
  });
});
