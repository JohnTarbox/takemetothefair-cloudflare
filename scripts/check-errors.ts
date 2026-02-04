#!/usr/bin/env npx tsx
/**
 * CLI script to query production error logs
 *
 * Usage:
 *   npx tsx scripts/check-errors.ts [options]
 *
 * Options:
 *   --since <time>    Filter logs from last N hours/days (e.g., "24h", "7d")
 *   --level <level>   Filter by level: error, warn, info
 *   --source <text>   Filter by source (partial match)
 *   --search <text>   Search in message (partial match)
 *   --limit <n>       Number of logs to fetch (default: 50, max: 200)
 *   --url <url>       Base URL (default: http://localhost:3000 or SITE_URL env)
 *   --json            Output raw JSON instead of formatted text
 *
 * Examples:
 *   npx tsx scripts/check-errors.ts --since 24h --level error
 *   npx tsx scripts/check-errors.ts --search "database" --limit 100
 *   npx tsx scripts/check-errors.ts --url https://takemetothefair.pages.dev --json
 */

interface ErrorLog {
  id: string;
  timestamp: number;
  time: string;
  level: string;
  message: string;
  context: string;
  url: string | null;
  method: string | null;
  statusCode: number | null;
  stackTrace: string | null;
  userAgent: string | null;
  source: string | null;
}

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        result[key] = nextArg;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

function parseSince(since: string): number | null {
  const match = since.match(/^(\d+)([hd])$/);
  if (!match) return null;
  const [, num, unit] = match;
  const hours = unit === "d" ? parseInt(num) * 24 : parseInt(num);
  return Math.floor(Date.now() / 1000) - hours * 3600;
}

function levelColor(level: string): string {
  switch (level) {
    case "error":
      return COLORS.red;
    case "warn":
      return COLORS.yellow;
    case "info":
      return COLORS.blue;
    default:
      return COLORS.reset;
  }
}

function formatLog(log: ErrorLog): string {
  const lines: string[] = [];
  const color = levelColor(log.level);

  lines.push(
    `${color}${COLORS.bold}[${log.level.toUpperCase()}]${COLORS.reset} ${log.time}`
  );
  lines.push(`  ${log.message}`);

  if (log.source) {
    lines.push(`  ${COLORS.gray}Source: ${log.source}${COLORS.reset}`);
  }
  if (log.method && log.url) {
    lines.push(`  ${COLORS.gray}${log.method} ${log.url}${COLORS.reset}`);
  }
  if (log.statusCode) {
    lines.push(`  ${COLORS.gray}Status: ${log.statusCode}${COLORS.reset}`);
  }
  if (log.stackTrace) {
    lines.push(`  ${COLORS.gray}Stack:${COLORS.reset}`);
    const stackLines = log.stackTrace.split("\n").slice(0, 5);
    for (const line of stackLines) {
      lines.push(`    ${COLORS.gray}${line}${COLORS.reset}`);
    }
    if (log.stackTrace.split("\n").length > 5) {
      lines.push(`    ${COLORS.gray}...${COLORS.reset}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: npx tsx scripts/check-errors.ts [options]

Options:
  --since <time>    Filter logs from last N hours/days (e.g., "24h", "7d")
  --level <level>   Filter by level: error, warn, info
  --source <text>   Filter by source (partial match)
  --search <text>   Search in message (partial match)
  --limit <n>       Number of logs to fetch (default: 50, max: 200)
  --url <url>       Base URL (default: http://localhost:3000 or SITE_URL env)
  --json            Output raw JSON instead of formatted text
  --help            Show this help message

Examples:
  npx tsx scripts/check-errors.ts --since 24h --level error
  npx tsx scripts/check-errors.ts --search "database" --limit 100
`);
    process.exit(0);
  }

  const baseUrl =
    (args.url as string) ||
    process.env.SITE_URL ||
    "http://localhost:3000";
  const params = new URLSearchParams();

  if (args.limit) params.set("limit", args.limit as string);
  else params.set("limit", "50");

  if (args.level) params.set("level", args.level as string);
  if (args.source) params.set("source", args.source as string);
  if (args.search) params.set("q", args.search as string);

  const endpoint = `${baseUrl}/api/admin/logs?${params}`;

  console.log(`${COLORS.gray}Fetching logs from: ${endpoint}${COLORS.reset}\n`);

  try {
    const res = await fetch(endpoint, {
      headers: {
        Cookie: process.env.AUTH_COOKIE || "",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `${COLORS.red}Error: ${res.status} ${res.statusText}${COLORS.reset}`
      );
      console.error(text);
      console.error(
        `\n${COLORS.yellow}Note: This endpoint requires admin authentication.${COLORS.reset}`
      );
      console.error(
        `Set AUTH_COOKIE env var with your session cookie for authenticated access.`
      );
      process.exit(1);
    }

    const logs: ErrorLog[] = await res.json();

    // Filter by --since if provided
    let filteredLogs = logs;
    if (args.since) {
      const cutoff = parseSince(args.since as string);
      if (cutoff) {
        filteredLogs = logs.filter((log) => log.timestamp >= cutoff);
      } else {
        console.error(
          `${COLORS.yellow}Warning: Invalid --since format. Use "24h" or "7d".${COLORS.reset}`
        );
      }
    }

    if (args.json) {
      console.log(JSON.stringify(filteredLogs, null, 2));
    } else {
      if (filteredLogs.length === 0) {
        console.log("No log entries found matching the criteria.");
      } else {
        console.log(`Found ${filteredLogs.length} log entries:\n`);
        for (const log of filteredLogs) {
          console.log(formatLog(log));
          console.log("");
        }
      }

      // Summary
      const errorCount = filteredLogs.filter((l) => l.level === "error").length;
      const warnCount = filteredLogs.filter((l) => l.level === "warn").length;
      const infoCount = filteredLogs.filter((l) => l.level === "info").length;

      console.log(
        `${COLORS.gray}Summary: ${COLORS.red}${errorCount} errors${COLORS.reset}, ${COLORS.yellow}${warnCount} warnings${COLORS.reset}, ${COLORS.blue}${infoCount} info${COLORS.reset}`
      );
    }
  } catch (error) {
    console.error(`${COLORS.red}Failed to fetch logs:${COLORS.reset}`, error);
    process.exit(1);
  }
}

main();
