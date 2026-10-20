/**
 * OPE-1316 Ask 2 — re-measure AI extraction latency and output size on real
 * pages, with the extractor code that ships.
 *
 * Runs `extractMultipleEvents` from src/lib/url-import/ai-extractor.ts locally,
 * with an `ai` binding that calls Workers AI over Cloudflare's REST API, and a
 * generous limit so the TRUE elapsed time is recorded rather than cut off. From
 * that, whether each page would finish inside the interactive (20 s) and the
 * unattended (90 s) limits is derived. Read-only: no event, no D1 write.
 *
 * ⚠️ Instrument limits: REST latency includes the network round trip to the
 * API, so it reads somewhat above what the Worker's AI binding sees; the page
 * text comes from this script's own fetch + html-parser, not the MCP Worker's
 * submitFetch (Browser Rendering fallback not used), so input sizes can differ.
 *
 * Usage (needs CLOUDFLARE_API_TOKEN with Workers AI read, CLOUDFLARE_ACCOUNT_ID):
 *   npx tsx scripts/measure-extract-latency-ope1316.ts [url ...]
 */
import { extractMultipleEvents } from "@/lib/url-import/ai-extractor";
import { extractTextFromHtml, extractMetadata } from "@/lib/url-import/html-parser";

const DEFAULT_URLS = [
  "https://www.heathfair.org/",
  "https://www.mafa.org/2026fairsbydate.html",
  "https://www.thewestfieldfair.com/events",
  "https://www.hardwickfair.com/program",
  "https://mainecrafts.org/programs/calendar-of-events/",
  "https://near-fest.com/",
  "https://www.hackmatackplayhouse.org/",
  "https://share.google/g2SzVzDbYq2WHPr2f",
  "https://www.easternstatesexposition.com/events/2026/hamden-county-4-h-fair",
  "https://www.btownfair.com/",
  "https://www.fsf.org/blogs/community/2026-encryptfest",
];

const MEASURE_LIMIT_MS = 150_000;

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account)
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;

  console.log("| URL | time | ≤20 s | ≤90 s | input chars | output chars | events |");
  console.log("|---|---|---|---|---|---|---|");
  for (const url of urls) {
    let outputChars = 0;
    const ai = {
      run: async (model: string, input: unknown) => {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        );
        const json = (await res.json()) as { result?: { response?: unknown } };
        const r = json.result ?? {};
        const resp = (r as { response?: unknown }).response;
        outputChars = typeof resp === "string" ? resp.length : JSON.stringify(resp ?? "").length;
        return r;
      },
    };
    let content = "";
    let metadata = {};
    try {
      const page = await fetch(url, {
        headers: { "User-Agent": "MeetMeAtTheFair/1.0 (+https://meetmeatthefair.com)" },
        redirect: "follow",
      });
      const html = await page.text();
      content = extractTextFromHtml(html);
      metadata = extractMetadata(html);
    } catch (e) {
      console.log(`| ${url} | fetch failed: ${(e as Error).message} | | | | | |`);
      continue;
    }
    const started = Date.now();
    let events = "—";
    try {
      const r = await extractMultipleEvents(
        ai as never,
        content,
        metadata as never,
        undefined,
        MEASURE_LIMIT_MS
      );
      events = String(r.events.length);
    } catch (e) {
      events = `error: ${(e as Error).message.slice(0, 60)}`;
    }
    const s = (Date.now() - started) / 1000;
    console.log(
      `| ${url} | ${s.toFixed(1)} s | ${s <= 20 ? "yes" : "no"} | ${s <= 90 ? "yes" : "no"} | ${content.length.toLocaleString()} | ${outputChars.toLocaleString()} | ${events} |`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
