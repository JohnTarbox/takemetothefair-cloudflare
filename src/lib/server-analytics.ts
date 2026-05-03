import { analyticsEvents } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

interface TrackServerEventOptions {
  eventName: string;
  eventCategory: string;
  properties?: Record<string, unknown>;
  userId?: string;
  source?: string;
}

/**
 * Track a server-side analytics event to D1.
 * Use for events that can't be tracked client-side:
 * - Admin actions (approve/reject events/vendors)
 * - Status transitions
 * - Scraper results
 * - Import operations
 *
 * Never throws — failures are silently logged.
 */
export async function trackServerEvent(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  options: TrackServerEventOptions
): Promise<void> {
  if (!db) return;

  try {
    await db.insert(analyticsEvents).values({
      id: crypto.randomUUID(),
      eventName: options.eventName,
      eventCategory: options.eventCategory,
      timestamp: new Date(),
      properties: options.properties ? JSON.stringify(options.properties) : "{}",
      userId: options.userId,
      source: options.source,
    });
  } catch {
    // Never throw from analytics — don't break the request
    console.error(`[Analytics] Failed to track event: ${options.eventName}`);
  }
}

// ── Convenience helpers for common server-side events ──

export async function trackEventStatusChange(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  eventId: string,
  oldStatus: string,
  newStatus: string,
  userId?: string
) {
  return trackServerEvent(db, {
    eventName: "event_status_change",
    eventCategory: "admin",
    properties: { eventId, oldStatus, newStatus },
    userId,
    source: "admin",
  });
}

export async function trackVendorStatusChange(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  vendorId: string,
  eventId: string,
  oldStatus: string,
  newStatus: string,
  userId?: string
) {
  return trackServerEvent(db, {
    eventName: "vendor_status_change",
    eventCategory: "admin",
    properties: { vendorId, eventId, oldStatus, newStatus },
    userId,
    source: "admin",
  });
}
