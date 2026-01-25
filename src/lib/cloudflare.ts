import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./db/schema";
import { readdirSync } from "fs";

// Get local SQLite database for development
function getLocalDb() {
  const d1Dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
  try {
    const dbFiles = readdirSync(d1Dir).filter(f => f.endsWith('.sqlite') && f !== 'local.sqlite');
    const dbPath = dbFiles.length > 0 ? `${d1Dir}/${dbFiles[0]}` : `${d1Dir}/local.sqlite`;
    const sqlite = new Database(dbPath);
    return drizzleBetterSqlite(sqlite, { schema });
  } catch (e) {
    console.error("Failed to connect to local database:", e);
    throw new Error("Database not available");
  }
}

// For local development, always use better-sqlite3
// When deployed to Cloudflare, this file should be replaced with one that uses D1
export function getCloudflareDb() {
  return getLocalDb();
}

export function getCloudflareEnv() {
  return {};
}
