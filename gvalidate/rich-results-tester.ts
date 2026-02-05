import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { ValidationResult, DetectedItem, ValidationIssue } from "./types";

export class RichResultsTester {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async init() {
    this.browser = await chromium.launch({
      headless: true,
    });
    const context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
    this.page = await context.newPage();
  }

  async testUrl(
    url: string,
    entityType: string,
    verbose: boolean = false
  ): Promise<ValidationResult> {
    if (!this.page) throw new Error("Browser not initialized");

    // Generate the direct test URL for manual verification
    const encodedUrl = encodeURIComponent(url);
    const directTestUrl = `${config.googleTestUrl}?url=${encodedUrl}`;

    try {
      // Navigate to Google Rich Results Test with the URL pre-filled
      if (verbose) console.log("  → Navigating to Google Rich Results Test...");
      await this.page.goto(directTestUrl, {
        timeout: config.timeouts.pageLoad,
        waitUntil: "networkidle",
      });

      // Wait for page to load
      await this.page.waitForTimeout(3000);

      // Check for authentication requirement
      const pageText = (await this.page.textContent("body")) || "";
      const requiresAuth =
        pageText.includes("Log in and try again") ||
        pageText.includes("Sign in") ||
        pageText.includes("Something went wrong");

      if (requiresAuth) {
        if (verbose) {
          console.log("  → Google requires authentication for automated testing");
        }
        return {
          url,
          entityType: entityType as "vendor" | "event" | "venue",
          timestamp: new Date().toISOString(),
          status: "error",
          detectedItems: [],
          errors: [
            {
              type: "error",
              message: "Google Rich Results Test requires authentication. Test manually at the URL below.",
              schema: "",
            },
          ],
          warnings: [],
          googleTestUrl: directTestUrl,
        };
      }

      // Try to click the TEST URL button if it's visible
      if (verbose) console.log("  → Looking for TEST URL button...");

      const buttonSelectors = [
        'button:has-text("TEST URL")',
        'button:has-text("Test URL")',
        'button[type="submit"]',
      ];

      for (const selector of buttonSelectors) {
        try {
          const button = await this.page.$(selector);
          if (button && (await button.isVisible())) {
            await button.click();
            if (verbose) console.log("  → Clicked TEST URL button");
            break;
          }
        } catch {
          // Try next selector
        }
      }

      // Wait for results - look for URL change or results content
      if (verbose) console.log("  → Waiting for Google to analyze URL...");

      const startTime = Date.now();
      let resultsFound = false;

      while (Date.now() - startTime < config.timeouts.testComplete) {
        const currentUrl = this.page.url();
        const currentText = (await this.page.textContent("body")) || "";

        // Check if we got results
        if (
          currentUrl.includes("/result?id=") ||
          currentText.includes("items detected") ||
          currentText.includes("No items detected") ||
          currentText.includes("couldn't detect")
        ) {
          resultsFound = true;
          if (verbose) console.log("  → Results detected");
          break;
        }

        // Check if authentication is now required
        if (
          currentText.includes("Log in and try again") ||
          currentText.includes("Something went wrong")
        ) {
          if (verbose) console.log("  → Authentication required");
          return {
            url,
            entityType: entityType as "vendor" | "event" | "venue",
            timestamp: new Date().toISOString(),
            status: "error",
            detectedItems: [],
            errors: [
              {
                type: "error",
                message: "Google Rich Results Test requires authentication. Test manually at the URL below.",
                schema: "",
              },
            ],
            warnings: [],
            googleTestUrl: directTestUrl,
          };
        }

        await this.page.waitForTimeout(1000);
      }

      if (!resultsFound) {
        if (verbose) {
          console.log("  → Timeout - no results found");
          const debugPath = `gvalidate-results/screenshots/debug-${Date.now()}.png`;
          await this.takeScreenshot(debugPath);
          console.log(`  → Debug screenshot: ${debugPath}`);
        }
        return {
          url,
          entityType: entityType as "vendor" | "event" | "venue",
          timestamp: new Date().toISOString(),
          status: "error",
          detectedItems: [],
          errors: [
            {
              type: "error",
              message: "Timeout waiting for results. Test manually at the URL below.",
              schema: "",
            },
          ],
          warnings: [],
          googleTestUrl: directTestUrl,
        };
      }

      // Wait for content to fully render
      await this.page.waitForTimeout(2000);

      // Extract results
      return await this.extractResults(url, entityType, verbose, directTestUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        url,
        entityType: entityType as "vendor" | "event" | "venue",
        timestamp: new Date().toISOString(),
        status: "error",
        detectedItems: [],
        errors: [
          {
            type: "error",
            message: `Automation failed: ${message}. Test manually at the URL below.`,
            schema: "",
          },
        ],
        warnings: [],
        googleTestUrl: directTestUrl,
      };
    }
  }

  private async extractResults(
    url: string,
    entityType: string,
    verbose: boolean = false,
    directTestUrl: string
  ): Promise<ValidationResult> {
    if (!this.page) throw new Error("Browser not initialized");

    const currentUrl = this.page.url();
    const pageText = (await this.page.textContent("body")) || "";

    if (verbose) {
      console.log("  → Extracting results from page...");
    }

    const detectedItems: DetectedItem[] = [];
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // Parse the page text for key indicators
    const itemsDetectedMatch = pageText.match(/(\d+)\s*items?\s*detected/i);
    const itemCount = itemsDetectedMatch ? parseInt(itemsDetectedMatch[1]) : 0;

    // Check validity status
    const allValid = pageText.toLowerCase().includes("all items are valid") ||
                     pageText.toLowerCase().includes("all valid");
    const someInvalid = pageText.toLowerCase().includes("some are invalid") ||
                        pageText.toLowerCase().includes("invalid");
    const noItems = pageText.toLowerCase().includes("no items detected") ||
                    pageText.toLowerCase().includes("couldn't detect");

    // Try to find specific schema types
    const schemaTypes = [
      "Event", "LocalBusiness", "Organization", "Place", "Product",
      "Breadcrumb", "BreadcrumbList", "FAQPage", "Article", "Review",
      "Recipe", "Video", "Course", "JobPosting", "Store", "FoodEstablishment"
    ];

    for (const schemaType of schemaTypes) {
      const regex = new RegExp(`\\b${schemaType}\\b`, "i");
      if (regex.test(pageText)) {
        detectedItems.push({
          type: schemaType,
          status: someInvalid ? "invalid" : "valid",
          errorCount: 0,
          warningCount: 0,
        });
      }
    }

    if (itemCount > 0 && detectedItems.length === 0) {
      detectedItems.push({
        type: `${itemCount} schema item(s)`,
        status: someInvalid ? "invalid" : "valid",
        errorCount: 0,
        warningCount: 0,
      });
    }

    // Determine overall status
    let status: "valid" | "invalid" | "error" = "valid";

    if (noItems) {
      status = "invalid";
      errors.push({
        type: "error",
        message: "No structured data items detected on this page",
        schema: "",
      });
    } else if (someInvalid) {
      status = "invalid";
      errors.push({
        type: "error",
        message: "Some items are invalid - check Google Rich Results Test for details",
        schema: "",
      });
    }

    if (verbose) {
      console.log(`  → Items detected: ${itemCount}`);
      console.log(`  → Status: ${allValid ? "All valid" : someInvalid ? "Some invalid" : noItems ? "No items" : "Unknown"}`);
    }

    // Use the result URL if we have it, otherwise the direct test URL
    const resultUrl = currentUrl.includes("/result?id=") ? currentUrl : directTestUrl;

    return {
      url,
      entityType: entityType as "vendor" | "event" | "venue",
      timestamp: new Date().toISOString(),
      status,
      detectedItems,
      errors,
      warnings,
      googleTestUrl: resultUrl,
    };
  }

  async takeScreenshot(filePath: string): Promise<void> {
    if (this.page) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await this.page.screenshot({ path: filePath, fullPage: true });
    }
  }

  async close() {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }
}

/**
 * Generate Google Rich Results Test URLs without automation
 * This is useful when authentication blocks automated testing
 */
export function generateTestUrls(urls: string[]): { url: string; testUrl: string }[] {
  return urls.map((url) => ({
    url,
    testUrl: `${config.googleTestUrl}?url=${encodeURIComponent(url)}`,
  }));
}
