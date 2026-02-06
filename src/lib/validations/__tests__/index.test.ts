/**
 * Tests for Zod validation schemas
 */

import { describe, it, expect } from "vitest";
import {
  venueCreateSchema,
  venueUpdateSchema,
  promoterCreateSchema,
  vendorCreateSchema,
  eventCreateSchema,
  eventUpdateSchema,
  eventDaySchema,
  eventVendorCreateSchema,
  eventVendorAddSchema,
  eventVendorUpdateSchema,
  userUpdateSchema,
  validateRequestBody,
} from "../index";
import { z } from "zod";

describe("venueCreateSchema", () => {
  const validVenue = {
    name: "Test Venue",
    address: "123 Main St",
    city: "Portland",
    state: "ME",
    zip: "04101",
  };

  it("validates a minimal valid venue", () => {
    const result = venueCreateSchema.safeParse(validVenue);
    expect(result.success).toBe(true);
  });

  it("validates a complete venue", () => {
    const completeVenue = {
      ...validVenue,
      latitude: 43.6591,
      longitude: -70.2568,
      capacity: 500,
      amenities: ["parking", "wifi"],
      contactEmail: "venue@example.com",
      contactPhone: "207-555-1234",
      website: "https://example.com",
      description: "A great venue",
      imageUrl: "https://example.com/image.jpg",
      status: "ACTIVE",
    };
    const result = venueCreateSchema.safeParse(completeVenue);
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = venueCreateSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path[0]);
      expect(paths).toContain("name");
      expect(paths).toContain("address");
      expect(paths).toContain("city");
      expect(paths).toContain("state");
      expect(paths).toContain("zip");
    }
  });

  it("rejects empty name", () => {
    const result = venueCreateSchema.safeParse({ ...validVenue, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name exceeding max length", () => {
    const result = venueCreateSchema.safeParse({
      ...validVenue,
      name: "a".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it("validates latitude range (-90 to 90)", () => {
    expect(venueCreateSchema.safeParse({ ...validVenue, latitude: 0 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, latitude: 90 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, latitude: -90 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, latitude: 91 }).success).toBe(false);
    expect(venueCreateSchema.safeParse({ ...validVenue, latitude: -91 }).success).toBe(false);
  });

  it("validates longitude range (-180 to 180)", () => {
    expect(venueCreateSchema.safeParse({ ...validVenue, longitude: 0 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, longitude: 180 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, longitude: -180 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, longitude: 181 }).success).toBe(false);
    expect(venueCreateSchema.safeParse({ ...validVenue, longitude: -181 }).success).toBe(false);
  });

  it("validates capacity as positive integer", () => {
    expect(venueCreateSchema.safeParse({ ...validVenue, capacity: 100 }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, capacity: 0 }).success).toBe(false);
    expect(venueCreateSchema.safeParse({ ...validVenue, capacity: -1 }).success).toBe(false);
    expect(venueCreateSchema.safeParse({ ...validVenue, capacity: 100.5 }).success).toBe(false);
  });

  it("validates email format", () => {
    expect(venueCreateSchema.safeParse({ ...validVenue, contactEmail: "valid@example.com" }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, contactEmail: "invalid-email" }).success).toBe(false);
  });

  it("validates website as URL", () => {
    expect(venueCreateSchema.safeParse({ ...validVenue, website: "https://example.com" }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, website: "not-a-url" }).success).toBe(false);
  });

  it("validates status enum", () => {
    expect(venueCreateSchema.safeParse({ ...validVenue, status: "ACTIVE" }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, status: "INACTIVE" }).success).toBe(true);
    expect(venueCreateSchema.safeParse({ ...validVenue, status: "INVALID" }).success).toBe(false);
  });

  it("allows null for optional fields", () => {
    const result = venueCreateSchema.safeParse({
      ...validVenue,
      latitude: null,
      longitude: null,
      capacity: null,
      contactEmail: null,
      contactPhone: null,
      website: null,
      description: null,
      imageUrl: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("venueUpdateSchema", () => {
  it("allows partial updates", () => {
    const result = venueUpdateSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("allows empty update", () => {
    const result = venueUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("still validates field constraints", () => {
    const result = venueUpdateSchema.safeParse({ latitude: 200 });
    expect(result.success).toBe(false);
  });
});

describe("promoterCreateSchema", () => {
  const validPromoter = {
    companyName: "Event Promoters Inc",
  };

  it("validates a minimal valid promoter", () => {
    const result = promoterCreateSchema.safeParse(validPromoter);
    expect(result.success).toBe(true);
  });

  it("validates a complete promoter", () => {
    const completePromoter = {
      ...validPromoter,
      userId: "550e8400-e29b-41d4-a716-446655440000",
      description: "We promote great events",
      website: "https://promoters.example.com",
      socialLinks: JSON.stringify({ twitter: "@promoters" }),
      logoUrl: "https://example.com/logo.png",
      verified: true,
    };
    const result = promoterCreateSchema.safeParse(completePromoter);
    expect(result.success).toBe(true);
  });

  it("validates userId as UUID", () => {
    expect(promoterCreateSchema.safeParse({
      ...validPromoter,
      userId: "550e8400-e29b-41d4-a716-446655440000",
    }).success).toBe(true);

    expect(promoterCreateSchema.safeParse({
      ...validPromoter,
      userId: "not-a-uuid",
    }).success).toBe(false);
  });

  it("defaults verified to false", () => {
    const result = promoterCreateSchema.safeParse(validPromoter);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verified).toBe(false);
    }
  });
});

describe("vendorCreateSchema", () => {
  const validVendor = {
    userId: "550e8400-e29b-41d4-a716-446655440000",
    businessName: "Artisan Crafts",
  };

  it("validates a minimal valid vendor", () => {
    const result = vendorCreateSchema.safeParse(validVendor);
    expect(result.success).toBe(true);
  });

  it("validates a complete vendor", () => {
    const completeVendor = {
      ...validVendor,
      description: "Handmade crafts and goods",
      vendorType: "Crafter",
      products: ["pottery", "jewelry", "textiles"],
      website: "https://artisan.example.com",
      socialLinks: JSON.stringify({ instagram: "@artisan" }),
      logoUrl: "https://example.com/logo.png",
      verified: true,
      commercial: false,
    };
    const result = vendorCreateSchema.safeParse(completeVendor);
    expect(result.success).toBe(true);
  });

  it("requires userId", () => {
    const result = vendorCreateSchema.safeParse({ businessName: "Test" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path[0] === "userId")).toBe(true);
    }
  });

  it("defaults products to empty array", () => {
    const result = vendorCreateSchema.safeParse(validVendor);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.products).toEqual([]);
    }
  });

  it("defaults commercial to false", () => {
    const result = vendorCreateSchema.safeParse(validVendor);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commercial).toBe(false);
    }
  });
});

describe("eventDaySchema", () => {
  const validDay = {
    date: "2025-03-15",
    openTime: "09:00",
    closeTime: "17:00",
  };

  it("validates a minimal valid event day", () => {
    const result = eventDaySchema.safeParse(validDay);
    expect(result.success).toBe(true);
  });

  it("validates a complete event day", () => {
    const completeDay = {
      ...validDay,
      notes: "Special hours for VIP",
      closed: false,
    };
    const result = eventDaySchema.safeParse(completeDay);
    expect(result.success).toBe(true);
  });

  it("validates date format (YYYY-MM-DD)", () => {
    expect(eventDaySchema.safeParse({ ...validDay, date: "2025-03-15" }).success).toBe(true);
    expect(eventDaySchema.safeParse({ ...validDay, date: "03/15/2025" }).success).toBe(false);
    expect(eventDaySchema.safeParse({ ...validDay, date: "March 15, 2025" }).success).toBe(false);
    expect(eventDaySchema.safeParse({ ...validDay, date: "2025-3-15" }).success).toBe(false);
  });

  it("validates time format (HH:MM)", () => {
    expect(eventDaySchema.safeParse({ ...validDay, openTime: "09:00" }).success).toBe(true);
    expect(eventDaySchema.safeParse({ ...validDay, openTime: "23:59" }).success).toBe(true);
    expect(eventDaySchema.safeParse({ ...validDay, openTime: "9:00" }).success).toBe(false);
    expect(eventDaySchema.safeParse({ ...validDay, openTime: "9:00 AM" }).success).toBe(false);
    expect(eventDaySchema.safeParse({ ...validDay, openTime: "09:00:00" }).success).toBe(false);
  });

  it("limits notes length", () => {
    const result = eventDaySchema.safeParse({
      ...validDay,
      notes: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("defaults closed to false", () => {
    const result = eventDaySchema.safeParse(validDay);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.closed).toBe(false);
    }
  });
});

describe("eventCreateSchema", () => {
  const validEvent = {
    name: "Summer Fair",
    promoterId: "promo-123",
  };

  it("validates a minimal valid event", () => {
    const result = eventCreateSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it("validates a complete event", () => {
    const completeEvent = {
      ...validEvent,
      description: "Annual summer celebration",
      venueId: "venue-123",
      startDate: "2025-06-15T10:00:00Z",
      endDate: "2025-06-17T18:00:00Z",
      datesConfirmed: true,
      recurrenceRule: "RRULE:FREQ=YEARLY",
      categories: ["fair", "outdoor"],
      tags: ["family", "food", "music"],
      ticketUrl: "https://tickets.example.com",
      ticketPriceMin: 10,
      ticketPriceMax: 50,
      imageUrl: "https://example.com/fair.jpg",
      featured: true,
      commercialVendorsAllowed: true,
      status: "APPROVED",
      sourceName: "MaineFairs",
      sourceUrl: "https://mainefairs.net",
      sourceId: "mf-2025-001",
      eventDays: [
        { date: "2025-06-15", openTime: "10:00", closeTime: "18:00" },
        { date: "2025-06-16", openTime: "10:00", closeTime: "18:00" },
      ],
    };
    const result = eventCreateSchema.safeParse(completeEvent);
    expect(result.success).toBe(true);
  });

  it("requires name", () => {
    const result = eventCreateSchema.safeParse({ promoterId: "promo-123" });
    expect(result.success).toBe(false);
  });

  it("requires promoterId", () => {
    const result = eventCreateSchema.safeParse({ name: "Test Event" });
    expect(result.success).toBe(false);
  });

  it("validates status enum", () => {
    const statuses = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "CANCELLED"];
    for (const status of statuses) {
      expect(eventCreateSchema.safeParse({ ...validEvent, status }).success).toBe(true);
    }
    expect(eventCreateSchema.safeParse({ ...validEvent, status: "INVALID" }).success).toBe(false);
  });

  it("validates ticket prices are non-negative", () => {
    expect(eventCreateSchema.safeParse({ ...validEvent, ticketPriceMin: 0 }).success).toBe(true);
    expect(eventCreateSchema.safeParse({ ...validEvent, ticketPriceMin: 10 }).success).toBe(true);
    expect(eventCreateSchema.safeParse({ ...validEvent, ticketPriceMin: -1 }).success).toBe(false);
  });

  it("validates datetime format for dates", () => {
    expect(eventCreateSchema.safeParse({
      ...validEvent,
      startDate: "2025-06-15T10:00:00Z",
    }).success).toBe(true);

    expect(eventCreateSchema.safeParse({
      ...validEvent,
      startDate: "2025-06-15",
    }).success).toBe(false);
  });

  it("defaults arrays to empty", () => {
    const result = eventCreateSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categories).toEqual([]);
      expect(result.data.tags).toEqual([]);
    }
  });

  it("defaults status to DRAFT", () => {
    const result = eventCreateSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("DRAFT");
    }
  });

  it("validates nested eventDays", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      eventDays: [
        { date: "invalid-date", openTime: "09:00", closeTime: "17:00" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts up to 100 eventDays", () => {
    const eventDays = Array.from({ length: 100 }, (_, i) => ({
      date: `2025-01-${String(i + 1).padStart(2, "0")}`,
      openTime: "09:00",
      closeTime: "17:00",
    }));
    // Need to use valid dates, so generate for multiple months
    const validDays = Array.from({ length: 100 }, (_, i) => {
      const date = new Date(2025, 0, i + 1); // Start from Jan 1, 2025
      return {
        date: date.toISOString().split("T")[0],
        openTime: "09:00",
        closeTime: "17:00",
      };
    });
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      eventDays: validDays,
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 100 eventDays", () => {
    const eventDays = Array.from({ length: 101 }, (_, i) => {
      const date = new Date(2025, 0, i + 1); // Start from Jan 1, 2025
      return {
        date: date.toISOString().split("T")[0],
        openTime: "09:00",
        closeTime: "17:00",
      };
    });
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      eventDays,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i =>
        i.message.includes("Maximum 100 days") || i.message.includes("Array must contain at most 100")
      )).toBe(true);
    }
  });
});

describe("eventCreateSchema cross-field validation", () => {
  const validEvent = {
    name: "Summer Fair",
    promoterId: "promo-123",
  };

  it("rejects endDate before startDate", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      startDate: "2025-06-17T10:00:00Z",
      endDate: "2025-06-15T18:00:00Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes("endDate"))).toBe(true);
      expect(result.error.issues.some(i => i.message.includes("End date must be on or after start date"))).toBe(true);
    }
  });

  it("accepts endDate equal to startDate", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      startDate: "2025-06-15T10:00:00Z",
      endDate: "2025-06-15T18:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts endDate after startDate", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      startDate: "2025-06-15T10:00:00Z",
      endDate: "2025-06-17T18:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts when only startDate is provided", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      startDate: "2025-06-15T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects ticketPriceMax less than ticketPriceMin", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      ticketPriceMin: 50,
      ticketPriceMax: 10,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes("ticketPriceMax"))).toBe(true);
      expect(result.error.issues.some(i => i.message.includes("Maximum ticket price"))).toBe(true);
    }
  });

  it("accepts ticketPriceMax equal to ticketPriceMin", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      ticketPriceMin: 25,
      ticketPriceMax: 25,
    });
    expect(result.success).toBe(true);
  });

  it("accepts ticketPriceMax greater than ticketPriceMin", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      ticketPriceMin: 10,
      ticketPriceMax: 50,
    });
    expect(result.success).toBe(true);
  });

  it("accepts when only ticketPriceMin is provided", () => {
    const result = eventCreateSchema.safeParse({
      ...validEvent,
      ticketPriceMin: 10,
    });
    expect(result.success).toBe(true);
  });
});

describe("eventUpdateSchema", () => {
  it("allows partial updates", () => {
    const result = eventUpdateSchema.safeParse({ name: "Updated Name" });
    expect(result.success).toBe(true);
  });

  it("allows empty update", () => {
    const result = eventUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("validates date order when both provided", () => {
    const result = eventUpdateSchema.safeParse({
      startDate: "2025-06-17T10:00:00Z",
      endDate: "2025-06-15T18:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("validates ticket price order when both provided", () => {
    const result = eventUpdateSchema.safeParse({
      ticketPriceMin: 50,
      ticketPriceMax: 10,
    });
    expect(result.success).toBe(false);
  });
});

describe("eventVendorCreateSchema", () => {
  const validEventVendor = {
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    vendorId: "550e8400-e29b-41d4-a716-446655440001",
  };

  it("validates valid event vendor", () => {
    const result = eventVendorCreateSchema.safeParse(validEventVendor);
    expect(result.success).toBe(true);
  });

  it("requires UUID format for eventId", () => {
    const result = eventVendorCreateSchema.safeParse({
      ...validEventVendor,
      eventId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("requires UUID format for vendorId", () => {
    const result = eventVendorCreateSchema.safeParse({
      ...validEventVendor,
      vendorId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("validates status enum", () => {
    const statuses = ["PENDING", "APPROVED", "REJECTED"];
    for (const status of statuses) {
      expect(eventVendorCreateSchema.safeParse({
        ...validEventVendor,
        status,
      }).success).toBe(true);
    }
    expect(eventVendorCreateSchema.safeParse({
      ...validEventVendor,
      status: "INVALID",
    }).success).toBe(false);
  });

  it("defaults status to PENDING", () => {
    const result = eventVendorCreateSchema.safeParse(validEventVendor);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("PENDING");
    }
  });

  it("limits boothInfo length", () => {
    const result = eventVendorCreateSchema.safeParse({
      ...validEventVendor,
      boothInfo: "a".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe("eventVendorAddSchema", () => {
  it("defaults status to APPROVED", () => {
    const result = eventVendorAddSchema.safeParse({
      vendorId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("APPROVED");
    }
  });
});

describe("eventVendorUpdateSchema", () => {
  it("requires eventVendorId as UUID", () => {
    const result = eventVendorUpdateSchema.safeParse({
      eventVendorId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);

    const invalidResult = eventVendorUpdateSchema.safeParse({
      eventVendorId: "not-a-uuid",
    });
    expect(invalidResult.success).toBe(false);
  });
});

describe("userUpdateSchema", () => {
  it("validates valid user update", () => {
    const result = userUpdateSchema.safeParse({
      name: "New Name",
      email: "new@example.com",
      role: "ADMIN",
    });
    expect(result.success).toBe(true);
  });

  it("validates role enum", () => {
    const roles = ["ADMIN", "PROMOTER", "VENDOR", "USER"];
    for (const role of roles) {
      expect(userUpdateSchema.safeParse({ role }).success).toBe(true);
    }
    expect(userUpdateSchema.safeParse({ role: "INVALID" }).success).toBe(false);
  });

  it("validates email format", () => {
    expect(userUpdateSchema.safeParse({ email: "valid@example.com" }).success).toBe(true);
    expect(userUpdateSchema.safeParse({ email: "invalid" }).success).toBe(false);
  });

  it("allows partial updates", () => {
    expect(userUpdateSchema.safeParse({}).success).toBe(true);
    expect(userUpdateSchema.safeParse({ name: "Only Name" }).success).toBe(true);
  });
});

describe("validateRequestBody", () => {
  const testSchema = z.object({
    name: z.string().min(1),
    count: z.number().int().positive(),
  });

  it("returns success with parsed data for valid input", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ name: "Test", count: 5 }),
    });

    const result = await validateRequestBody(request, testSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Test", count: 5 });
    }
  });

  it("returns error for invalid data", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ name: "", count: -1 }),
    });

    const result = await validateRequestBody(request, testSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns error for invalid JSON", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "not valid json",
    });

    const result = await validateRequestBody(request, testSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Invalid JSON body");
      expect(result.issues).toEqual([]);
    }
  });

  it("formats error message with field paths", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ name: "", count: "not a number" }),
    });

    const result = await validateRequestBody(request, testSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("name:");
      expect(result.error).toContain("count:");
    }
  });
});
