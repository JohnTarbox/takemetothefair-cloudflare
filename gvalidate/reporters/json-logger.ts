import * as fs from "fs";
import * as path from "path";
import { ValidationResult, RunSummary } from "../types";

export async function writeJsonLog(
  results: ValidationResult[],
  filePath: string,
  totalUrls: number,
  stoppedEarly: boolean
): Promise<RunSummary> {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const invalid = results.filter((r) => r.status === "invalid" || r.status === "error").length;
  const withWarnings = results.filter((r) => r.warnings.length > 0).length;
  const errors = results.filter((r) => r.status === "error").length;

  const runSummary: RunSummary = {
    runId: path.basename(filePath, ".json"),
    baseUrl: "https://meetmeatthefair.com",
    startTime: results[0]?.timestamp || new Date().toISOString(),
    endTime: results[results.length - 1]?.timestamp || new Date().toISOString(),
    stoppedEarly,
    summary: {
      totalUrls,
      tested: results.length,
      valid: results.length - invalid,
      invalid,
      withWarnings,
      errors,
    },
    results,
  };

  fs.writeFileSync(filePath, JSON.stringify(runSummary, null, 2));

  return runSummary;
}
