import { vi } from "vitest";

/**
 * Creates a mock Drizzle database client for testing
 */
export function createMockDb() {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    then: vi.fn(),
  };

  return {
    ...mockChain,
    query: {
      users: { findFirst: vi.fn(), findMany: vi.fn() },
      events: { findFirst: vi.fn(), findMany: vi.fn() },
      venues: { findFirst: vi.fn(), findMany: vi.fn() },
      vendors: { findFirst: vi.fn(), findMany: vi.fn() },
      promoters: { findFirst: vi.fn(), findMany: vi.fn() },
      userFavorites: { findFirst: vi.fn(), findMany: vi.fn() },
    },
  };
}

/**
 * Helper to create mock user data
 */
export function createMockUser(overrides = {}) {
  return {
    id: "user-1",
    email: "test@example.com",
    name: "Test User",
    role: "USER",
    passwordHash: "hashed-password",
    image: null,
    emailVerified: null,
    oauthProvider: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

/**
 * Helper to create mock event data
 */
export function createMockEvent(overrides = {}) {
  return {
    id: "event-1",
    name: "Test Fair",
    slug: "test-fair",
    description: "A test fair event",
    startDate: new Date("2024-06-01"),
    endDate: new Date("2024-06-03"),
    venueId: "venue-1",
    promoterId: "promoter-1",
    status: "APPROVED",
    viewCount: 0,
    featured: false,
    categories: "[]",
    tags: "[]",
    datesConfirmed: true,
    commercialVendorsAllowed: true,
    syncEnabled: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

/**
 * Helper to create mock venue data
 */
export function createMockVenue(overrides = {}) {
  return {
    id: "venue-1",
    name: "Test Fairgrounds",
    slug: "test-fairgrounds",
    address: "123 Fair St",
    city: "Fairville",
    state: "CA",
    zip: "12345",
    status: "ACTIVE",
    latitude: null,
    longitude: null,
    capacity: null,
    amenities: "[]",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

/**
 * Helper to create mock vendor data
 */
export function createMockVendor(overrides = {}) {
  return {
    id: "vendor-1",
    userId: "user-1",
    businessName: "Test Vendor Co",
    slug: "test-vendor-co",
    vendorType: "FOOD",
    description: "Test vendor description",
    verified: false,
    commercial: false,
    products: "[]",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

/**
 * Helper to create mock promoter data
 */
export function createMockPromoter(overrides = {}) {
  return {
    id: "promoter-1",
    userId: "user-1",
    companyName: "Test Promotions",
    slug: "test-promotions",
    description: null,
    verified: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

/**
 * Helper to create mock favorite data
 */
export function createMockFavorite(overrides = {}) {
  return {
    id: "favorite-1",
    userId: "user-1",
    favoritableType: "EVENT",
    favoritableId: "event-1",
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}
