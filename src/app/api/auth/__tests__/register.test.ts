import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the hashPassword function
vi.mock("@/lib/auth", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed_password"),
}));

// Mock the cloudflare module
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn(),
};

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => mockDb),
}));

// Mock the logger
vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
}));

// Import after mocks are set up
import { POST } from "../register/route";

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for missing required fields", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid email format", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "invalid-email",
        password: "password123",
        name: "Test User",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("email");
  });

  it("returns 400 for password too short", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        password: "short",
        name: "Test User",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("8 characters");
  });

  it("returns 400 for name too short", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        password: "password123",
        name: "A",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("2 characters");
  });

  it("returns 400 when email already exists", async () => {
    mockDb.limit.mockResolvedValue([{ id: "existing-user" }]);

    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "existing@example.com",
        password: "password123",
        name: "Test User",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("already exists");
  });

  it("successfully registers a new user", async () => {
    mockDb.limit.mockResolvedValue([]);
    mockDb.values.mockResolvedValue(undefined);

    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "newuser@example.com",
        password: "password123",
        name: "New User",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.message).toBe("Account created successfully");
    expect(data.user.email).toBe("newuser@example.com");
    expect(data.user.name).toBe("New User");
    expect(data.user.role).toBe("USER");
  });

  it("successfully registers a vendor with businessName", async () => {
    mockDb.limit.mockResolvedValue([]);
    mockDb.values.mockResolvedValue(undefined);

    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "vendor@example.com",
        password: "password123",
        name: "Vendor User",
        role: "VENDOR",
        businessName: "My Vendor Business",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.user.role).toBe("VENDOR");
    // Verify both user and vendor insert were called
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it("successfully registers a promoter with companyName", async () => {
    mockDb.limit.mockResolvedValue([]);
    mockDb.values.mockResolvedValue(undefined);

    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "promoter@example.com",
        password: "password123",
        name: "Promoter User",
        role: "PROMOTER",
        companyName: "Events Inc",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.user.role).toBe("PROMOTER");
    // Verify both user and promoter insert were called
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for invalid role", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
        role: "INVALID_ROLE",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("defaults role to USER when not provided", async () => {
    mockDb.limit.mockResolvedValue([]);
    mockDb.values.mockResolvedValue(undefined);

    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "defaultrole@example.com",
        password: "password123",
        name: "Default Role User",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.user.role).toBe("USER");
  });

  it("handles database errors gracefully", async () => {
    mockDb.limit.mockRejectedValue(new Error("Database connection failed"));

    const request = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        password: "password123",
        name: "Test User",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toContain("error occurred");
  });
});
