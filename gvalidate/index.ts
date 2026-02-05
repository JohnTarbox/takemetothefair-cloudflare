#!/usr/bin/env npx tsx
import { parseArgs } from "util";
import * as fs from "fs";
import { parseSitemap } from "./sitemap-parser";
import { RichResultsTester, generateTestUrls } from "./rich-results-tester";
import { writeJsonLog } from "./reporters/json-logger";
import { generateMarkdownReport } from "./reporters/markdown-report";
import { config } from "./config";
import { ValidationResult } from "./types";

async function main() {
  const { values } = parseArgs({
    options: {
      type: { type: "string", short: "t" },
      limit: { type: "string", short: "l" },
      verbose: { type: "boolean", short: "v" },
      "no-fail-fast": { type: "boolean" },
      screenshot: { type: "boolean", short: "s" },
      "urls-only": { type: "boolean", short: "u" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
GVALIDATE - Google Rich Results Test for Structured Data

USAGE:
  npm run gvalidate [options]

OPTIONS:
  -t, --type <type>     Filter by entity type: vendor, event, venue
  -l, --limit <n>       Limit to first N URLs
  -v, --verbose         Show detailed progress
  -s, --screenshot      Take screenshots on failure
  -u, --urls-only       Generate test URLs only (no automation)
  --no-fail-fast        Continue testing after errors

EXAMPLES:
  npm run gvalidate                    # Test all URLs (fail-fast)
  npm run gvalidate -- --urls-only     # Generate clickable test URLs
  npm run gvalidate -- --type=vendor   # Test only vendors
  npm run gvalidate -- --limit=5       # Test first 5 URLs
  npm run gvalidate:all                # Test all without stopping

NOTE:
  Google's Rich Results Test may require authentication for automated
  testing. Use --urls-only to generate URLs for manual testing.
`);
    process.exit(0);
  }

  const failFast = !values["no-fail-fast"];
  const verbose = values.verbose;
  const takeScreenshots = values.screenshot;
  const urlsOnly = values["urls-only"];

  console.log("═".repeat(60));
  console.log("GVALIDATE - Google Rich Results Test");
  console.log("═".repeat(60));
  console.log();

  console.log("Fetching sitemap from production...");
  const sitemap = await parseSitemap(config.sitemapUrl);
  console.log(
    `Found: ${sitemap.vendors.length} vendors, ${sitemap.events.length} events, ${sitemap.venues.length} venues`
  );

  // Filter URLs by type
  let urls: { url: string; type: string }[] = [];
  if (!values.type || values.type === "vendor") {
    urls.push(...sitemap.vendors.map((u) => ({ url: u, type: "vendor" })));
  }
  if (!values.type || values.type === "event") {
    urls.push(...sitemap.events.map((u) => ({ url: u, type: "event" })));
  }
  if (!values.type || values.type === "venue") {
    urls.push(...sitemap.venues.map((u) => ({ url: u, type: "venue" })));
  }

  const totalUrls = urls.length;

  // Apply limit
  if (values.limit) {
    urls = urls.slice(0, parseInt(values.limit));
  }

  // URLs-only mode: generate test URLs without automation
  if (urlsOnly) {
    console.log();
    console.log(`Generating test URLs for ${urls.length} pages...`);
    console.log();

    const testUrls = generateTestUrls(urls.map((u) => u.url));

    // Group by type
    const byType: Record<string, typeof testUrls> = {};
    for (let i = 0; i < urls.length; i++) {
      const type = urls[i].type;
      if (!byType[type]) byType[type] = [];
      byType[type].push(testUrls[i]);
    }

    // Output URLs grouped by type
    for (const [type, typeUrls] of Object.entries(byType)) {
      console.log(`\n## ${type.toUpperCase()}S (${typeUrls.length})\n`);
      for (const { url, testUrl } of typeUrls) {
        const path = url.replace("https://meetmeatthefair.com", "");
        console.log(`${path}`);
        console.log(`  → ${testUrl}`);
      }
    }

    // Write to file
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = `${config.outputDir}/urls/${runId}.md`;
    const dir = `${config.outputDir}/urls`;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let markdown = `# Google Rich Results Test URLs\n\n`;
    markdown += `Generated: ${new Date().toLocaleString()}\n`;
    markdown += `Total URLs: ${urls.length}\n\n`;
    markdown += `Click any link below to test in Google's Rich Results Test.\n\n`;

    for (const [type, typeUrls] of Object.entries(byType)) {
      markdown += `## ${type.charAt(0).toUpperCase() + type.slice(1)}s (${typeUrls.length})\n\n`;
      for (const { url, testUrl } of typeUrls) {
        const path = url.replace("https://meetmeatthefair.com", "");
        markdown += `- [${path}](${testUrl})\n`;
      }
      markdown += "\n";
    }

    fs.writeFileSync(outputPath, markdown);

    console.log();
    console.log("═".repeat(60));
    console.log("TEST URLs GENERATED");
    console.log("═".repeat(60));
    console.log(`URLs saved to: ${outputPath}`);
    console.log();
    console.log("Open the markdown file and click links to test manually.");
    console.log();
    process.exit(0);
  }

  console.log();
  console.log(`Testing ${urls.length} URLs against Google Rich Results Test...`);
  console.log(
    `Mode: ${failFast ? "FAIL-FAST (stops on first error)" : "FULL (tests all URLs)"}`
  );
  console.log();

  const tester = new RichResultsTester();
  await tester.init();

  const results: ValidationResult[] = [];
  let stoppedEarly = false;
  let authRequired = false;

  for (let i = 0; i < urls.length; i++) {
    const { url, type } = urls[i];
    console.log(`[${i + 1}/${urls.length}] Testing: ${url}`);

    try {
      const result = await tester.testUrl(url, type, verbose);
      results.push(result);

      // Check if authentication is required
      if (result.errors.some((e) => e.message.includes("requires authentication"))) {
        authRequired = true;
        console.log(`  ⚠️  Google requires authentication`);
        console.log(`  → Test manually: ${result.googleTestUrl}`);

        if (failFast) {
          console.log();
          console.log("═".repeat(60));
          console.log("AUTHENTICATION REQUIRED");
          console.log("═".repeat(60));
          console.log();
          console.log("Google's Rich Results Test requires you to be logged in.");
          console.log();
          console.log("Options:");
          console.log("  1. Run with --urls-only to generate clickable test URLs");
          console.log("  2. Test manually by opening the URL above in your browser");
          console.log();
          console.log("═".repeat(60));
          stoppedEarly = true;
          break;
        }
        continue;
      }

      if (result.status === "invalid" || result.status === "error") {
        console.log(`  ❌ ${result.status.toUpperCase()} - ${result.errors.length} error(s)`);

        if (takeScreenshots) {
          const screenshotPath = `${config.outputDir}/screenshots/${type}-${url.split("/").pop()}.png`;
          await tester.takeScreenshot(screenshotPath);
          console.log(`  📸 Screenshot saved: ${screenshotPath}`);
        }

        // FAIL-FAST: Stop on first error and show details
        if (failFast && !authRequired) {
          console.log();
          console.log("═".repeat(60));
          console.log("STOPPING - ERRORS DETECTED");
          console.log("═".repeat(60));
          console.log();
          console.log(`URL: ${url}`);
          console.log(`Google Test: ${result.googleTestUrl}`);
          console.log();
          console.log("Errors found:");
          result.errors.forEach((err, idx) => {
            console.log(`  ${idx + 1}. ${err.message}${err.schema ? ` [${err.schema}]` : ""}`);
          });
          if (result.warnings.length > 0) {
            console.log();
            console.log("Warnings:");
            result.warnings.forEach((warn, idx) => {
              console.log(`  ${idx + 1}. ${warn.message}${warn.schema ? ` [${warn.schema}]` : ""}`);
            });
          }
          console.log();
          console.log("═".repeat(60));
          console.log("ACTION REQUIRED: Fix the above errors before continuing.");
          console.log('Run with --no-fail-fast to test all URLs regardless of errors.');
          console.log("═".repeat(60));
          console.log();
          stoppedEarly = true;
          break;
        }
      } else if (result.warnings.length > 0) {
        console.log(`  ⚠️  Valid with ${result.warnings.length} warning(s)`);
      } else {
        console.log(`  ✓ Valid`);
        if (result.detectedItems.length > 0) {
          console.log(`    Detected: ${result.detectedItems.map((i) => i.type).join(", ")}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ❌ ERROR: ${message}`);
      const errorResult: ValidationResult = {
        url,
        entityType: type as "vendor" | "event" | "venue",
        timestamp: new Date().toISOString(),
        status: "error",
        detectedItems: [],
        errors: [{ type: "error", message, schema: "" }],
        warnings: [],
        googleTestUrl: `${config.googleTestUrl}?url=${encodeURIComponent(url)}`,
      };
      results.push(errorResult);

      // FAIL-FAST: Also stop on fetch/automation errors
      if (failFast) {
        console.log();
        console.log("═".repeat(60));
        console.log("STOPPING - TEST ERROR");
        console.log("═".repeat(60));
        console.log();
        console.log(`Failed to test URL: ${url}`);
        console.log(`Error: ${message}`);
        console.log();
        console.log("This may be a network issue or Google blocking automation.");
        console.log('Run with --no-fail-fast to continue testing other URLs.');
        console.log("═".repeat(60));
        console.log();
        stoppedEarly = true;
        break;
      }
    }

    // Rate limiting delay
    if (i < urls.length - 1 && !stoppedEarly) {
      await new Promise((r) => setTimeout(r, config.timeouts.betweenTests));
    }
  }

  await tester.close();

  // Generate outputs
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = `${config.outputDir}/logs/${runId}.json`;
  const reportPath = `${config.outputDir}/reports/${runId}.md`;

  await writeJsonLog(results, jsonPath, totalUrls, stoppedEarly);
  await generateMarkdownReport(results, reportPath, stoppedEarly);

  // Summary
  const invalid = results.filter((r) => r.status === "invalid" || r.status === "error").length;
  const withWarnings = results.filter((r) => r.warnings.length > 0).length;

  console.log();
  console.log("═".repeat(60));
  console.log(stoppedEarly ? "GVALIDATE STOPPED" : "GVALIDATE COMPLETE");
  console.log("═".repeat(60));
  console.log(
    `Tested: ${results.length}/${urls.length} | Valid: ${results.length - invalid} | Invalid: ${invalid} | Warnings: ${withWarnings}`
  );
  console.log();
  console.log(`JSON Log: ${jsonPath}`);
  console.log(`Report:   ${reportPath}`);

  if (authRequired) {
    console.log();
    console.log("TIP: Run with --urls-only to generate clickable test URLs for manual testing.");
  }

  console.log();

  // Exit with error code if any invalid
  process.exit(invalid > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
