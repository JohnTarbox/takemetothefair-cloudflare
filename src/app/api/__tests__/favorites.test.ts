import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the auth module
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Mock the cloudflare module
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn(),
  delete: vi.fn().mockReturnThis(),
};

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => mockDb),
}));

// Import after mocks are set up
import { GET, POST, DELETE } from "../favorites/route";
import { auth } from "@/lib/auth";

const mockAuth = vi.mocked(auth);

describe("GET /api/favorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty favorites for unauthenticated user", async () => {
    mockAuth.mockResolvedValue(null);

    const request = new NextRequest("http://localhost:3000/api/favorites");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.favorites).toEqual([]);
  });

  it("returns favorites for authenticated user", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    mockDb.limit.mockResolvedValue([
      { id: "fav-1", favoritableType: "EVENT", favoritableId: "event-1" },
    ]);

    const request = new NextRequest("http://localhost:3000/api/favorites");
    const response = await GET(request);

    expect(response.status).toBe(200);
  });
});

describe("POST /api/favorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when user is not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const request = new NextRequest("http://localhost:3000/api/favorites", {
      method: "POST",
      body: JSON.stringify({ type: "EVENT", id: "event-1" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 400 for invalid type", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    const request = new NextRequest("http://localhost:3000/api/favorites", {
      method: "POST",
      body: JSON.stringify({ type: "INVALID", id: "event-1" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Invalid type or id");
  });

  it("returns 400 when id is missing", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    const request = new NextRequest("http://localhost:3000/api/favorites", {
      method: "POST",
      body: JSON.stringify({ type: "EVENT" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
  });

  it("adds favorite successfully", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    mockDb.limit.mockResolvedValue([]);
    mockDb.values.mockResolvedValue(undefined);

    const request = new NextRequest("http://localhost:3000/api/favorites", {
      method: "POST",
      body: JSON.stringify({ type: "EVENT", id: "event-1" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.favorited).toBe(true);
  });

  it("returns already favorited message", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    mockDb.limit.mockResolvedValue([{ id: "existing-fav" }]);

    const request = new NextRequest("http://localhost:3000/api/favorites", {
      method: "POST",
      body: JSON.stringify({ type: "EVENT", id: "event-1" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.favorited).toBe(true);
    expect(data.message).toBe("Already favorited");
  });
});

describe("DELETE /api/favorites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when user is not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost:3000/api/favorites?type=EVENT&id=event-1",
      { method: "DELETE" }
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 400 for invalid type", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    const request = new NextRequest(
      "http://localhost:3000/api/favorites?type=INVALID&id=event-1",
      { method: "DELETE" }
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
  });

  it("removes favorite successfully", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "test@example.com", role: "USER" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    });

    mockDb.where.mockResolvedValue(undefined);

    const request = new NextRequest(
      "http://localhost:3000/api/favorites?type=EVENT&id=event-1",
      { method: "DELETE" }
    );

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.favorited).toBe(false);
  });
});
