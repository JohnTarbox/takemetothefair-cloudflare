import { ImageResponse } from "next/og";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseJsonArray } from "@/types";

const CATEGORY_ACCENT_COLORS: Record<string, string> = {
  Fair: "#E8960C",
  Festival: "#3B6FD4",
  "Craft Show": "#9333ea",
  "Craft Fair": "#9333ea",
  Market: "#16a34a",
  "Farmers Market": "#059669",
};

function getCategoryAccent(categories: string[]): string {
  for (const cat of categories) {
    if (CATEGORY_ACCENT_COLORS[cat]) return CATEGORY_ACCENT_COLORS[cat];
  }
  return "#3B6FD4";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");

  if (!slug) {
    // Default OG image (no event specified)
    return new ImageResponse(
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#1E2761",
          color: "white",
        }}
      >
        <div style={{ fontSize: 64, fontWeight: "bold" }}>Meet Me at the Fair</div>
        <div style={{ fontSize: 28, color: "#d1d5db", marginTop: 16 }}>
          Discover Local Fairs, Festivals & Events
        </div>
        <div style={{ fontSize: 20, color: "#9ca3af", marginTop: 12 }}>meetmeatthefair.com</div>
      </div>,
      { width: 1200, height: 630 }
    );
  }

  const db = getCloudflareDb();
  const eventRows = await db
    .select({
      name: events.name,
      description: events.description,
      startDate: events.startDate,
      endDate: events.endDate,
      categories: events.categories,
      venueName: venues.name,
      venueCity: venues.city,
      venueState: venues.state,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(eq(events.slug, slug))
    .limit(1);

  if (eventRows.length === 0) {
    return new Response("Event not found", { status: 404 });
  }

  const event = eventRows[0];
  const categories = parseJsonArray(event.categories);
  const accentColor = getCategoryAccent(categories);
  const category = categories[0] || "";

  const formatDate = (date: Date | string | null) => {
    if (!date) return "";
    const d = new Date(date);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const dateStr = formatDate(event.startDate);
  const location = [event.venueName, event.venueCity, event.venueState].filter(Boolean).join(", ");

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#1E2761",
        color: "white",
        position: "relative",
      }}
    >
      {/* Top accent bar */}
      <div
        style={{
          height: 6,
          backgroundColor: accentColor,
          width: "100%",
        }}
      />

      {/* Content */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "48px 64px",
        }}
      >
        {/* Category badge */}
        {category && (
          <div
            style={{
              display: "flex",
              marginBottom: 24,
            }}
          >
            <span
              style={{
                backgroundColor: accentColor,
                color: "white",
                padding: "6px 16px",
                borderRadius: 20,
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              {category}
            </span>
          </div>
        )}

        {/* Event name */}
        <div
          style={{
            fontSize: 52,
            fontWeight: "bold",
            lineHeight: 1.15,
            maxWidth: 900,
          }}
        >
          {event.name}
        </div>

        {/* Date and location */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 28,
            fontSize: 24,
            color: "#d1d5db",
          }}
        >
          {dateStr && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: accentColor }}>📅</span> {dateStr}
            </div>
          )}
          {location && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: accentColor }}>📍</span> {location}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "20px 64px",
          borderTop: "1px solid rgba(255,255,255,0.1)",
          fontSize: 18,
          color: "#9ca3af",
        }}
      >
        <span>meetmeatthefair.com</span>
        <span style={{ color: accentColor, fontWeight: 600 }}>Meet Me at the Fair</span>
      </div>
    </div>,
    { width: 1200, height: 630 }
  );
}
