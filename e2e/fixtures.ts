/**
 * OPE-1669 — every spec imports `test` / `expect` from HERE, not from
 * "@playwright/test" (enforced by src/lib/__tests__/e2e-fixture-import-ope1669.test.ts).
 *
 * Why: on a production build, React streams each Suspense boundary as a hidden
 * `<div hidden id="S:n">` after `</main>` and reveals it later ($RC queues a
 * throttled $RV, ≥300 ms). If the boundary gets an update before it hydrates,
 * React renders it on the client while that hidden segment is still in <body>,
 * so for a moment the page holds TWO copies of its content. Playwright's strict
 * mode counts hidden nodes, so any page-wide CSS/text locator can throw
 * "resolved to 2 elements". Three CI runs on PR #1828 hit it on five different
 * specs, one or two at a time.
 *
 * So `page.goto` / `page.reload` return only once the streamed segments have
 * drained. Those are the only document loads. A client-side navigation (link
 * click, router.push) streams RSC, not hidden segments, and is unaffected.
 *
 * A segment that never drains is a real defect (its content was never
 * revealed), so the wait THROWS rather than passing quietly.
 */
import { test as base, type Page } from "@playwright/test";

export * from "@playwright/test";

export const STREAM_SEGMENT_SELECTOR = 'div[hidden][id^="S:"]';

/** Resolves once no streamed Suspense segment remains in the document. */
export async function waitForStreamedSegments(page: Page, timeout = 15_000): Promise<void> {
  try {
    await page.waitForFunction((sel) => !document.querySelector(sel), STREAM_SEGMENT_SELECTOR, {
      timeout,
    });
  } catch (err) {
    const left = await page
      .evaluate(
        (sel) => [...document.querySelectorAll(sel)].map((e) => e.id),
        STREAM_SEGMENT_SELECTOR
      )
      .catch(() => ["<page closed>"]);
    throw new Error(
      `OPE-1669: streamed Suspense segment(s) ${left.join(", ")} never revealed within ${timeout} ms on ${page.url()}`,
      { cause: err }
    );
  }
}

export const test = base.extend({
  // `runTest` is Playwright's fixture `use` callback, renamed: react-hooks lint reads
  // a function named `use` as React's `use()`.
  page: async ({ page }, runTest) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const res = await goto(...args);
      const waitUntil = args[1]?.waitUntil;
      // Only a load that waited for the document can be settled; a "commit" /
      // "domcontentloaded" caller asked not to wait for the stream.
      if (waitUntil === undefined || waitUntil === "load" || waitUntil === "networkidle") {
        await waitForStreamedSegments(page);
      }
      return res;
    };
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      const res = await reload(...args);
      const waitUntil = args[0]?.waitUntil;
      if (waitUntil === undefined || waitUntil === "load" || waitUntil === "networkidle") {
        await waitForStreamedSegments(page);
      }
      return res;
    };
    await runTest(page);
  },
});
