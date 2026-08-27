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
  // OPE-237's evidence write chains .onConflictDoNothing() off .values(); the
  // other inserts await .values() directly. Returning a thenable that ALSO
  // carries onConflictDoNothing satisfies both without a per-call branch.
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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(data.error).toContain("already exists");
  });

  // ── OPE-573 — business-name collision ──────────────────────────────────────
  //
  // The defect was not the error message. `users` + `user_roles` are inserted
  // BEFORE the vendor row and nothing spans them in a transaction, so a UNIQUE
  // failure on `vendors.slug` left a REAL account with no listing: the person
  // saw "an error occurred", and their retry hit "email already exists". Three
  // accounts are in that state on prod.
  //
  // So the load-bearing assertion in these tests is NOT the 409 — it is that
  // `db.insert` is never reached.

  const collidingVendorBody = {
    email: "newvendor@example.com",
    password: "password123",
    name: "New Vendor",
    role: "VENDOR",
    businessName: "21 Street Beads",
  };

  it("does not create an account when the business name collides", async () => {
    mockDb.limit
      .mockResolvedValueOnce([]) // no existing user with this email
      .mockResolvedValueOnce([{ slug: "21-street-beads", name: "21 Street Beads", claimed: 0 }]);

    const response = await POST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        body: JSON.stringify(collidingVendorBody),
      })
    );

    expect(response.status).toBe(409);
    // ⚠️ This is the regression guard. A 409 that still wrote the user row
    // would leave the person locked out exactly as before.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("hands back the existing listing so the form can offer the claim flow", async () => {
    mockDb.limit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slug: "21-street-beads", name: "21 Street Beads", claimed: 0 }]);

    const response = await POST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        body: JSON.stringify(collidingVendorBody),
      })
    );
    const data = (await response.json()) as any;

    expect(data.claimAvailable).toEqual({
      entityType: "VENDOR",
      slug: "21-street-beads",
      name: "21 Street Beads",
      claimUrl: "/claim/vendor/21-street-beads",
    });
    // Names the listing rather than saying "name taken" — the latter invites
    // "21 Street Beads LLC", which is the duplicate we are avoiding.
    expect(data.error).toContain("21 Street Beads");
    expect(data.error).not.toMatch(/UNIQUE|SQLITE|D1_ERROR/);
  });

  it("does NOT block a claim-funnel signup against the listing it means to claim", async () => {
    // claimSlug present = the user is claiming an EXISTING listing. Running the
    // collision check here would reject them for colliding with their own target.
    //
    // ⚠️ The collision row MUST be present for this test to mean anything. An
    // earlier version stubbed `limit` to always return [], so no collision
    // existed at all and the test passed whether or not the `!claimSlug` guard
    // ran — the mutant survived. Seed the collision, then assert it is ignored.
    mockDb.limit
      .mockResolvedValueOnce([]) // email is free
      .mockResolvedValueOnce([{ slug: "21-street-beads", name: "21 Street Beads", claimed: 0 }]);
    mockDb.values.mockResolvedValue(undefined);

    const response = await POST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ ...collidingVendorBody, claimSlug: "21-street-beads" }),
      })
    );

    expect(response.status).not.toBe(409);
  });

  it("applies the same check to promoters", async () => {
    // promoters.slug carries the same notNull().unique() and had the same gap.
    mockDb.limit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slug: "acme-events", name: "Acme Events", claimed: 1 }]);

    const response = await POST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: "promoter@example.com",
          password: "password123",
          name: "Promoter Person",
          role: "PROMOTER",
          companyName: "Acme Events",
        }),
      })
    );
    const data = (await response.json()) as any;

    expect(response.status).toBe(409);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(data.claimAvailable.claimUrl).toBe("/claim/promoter/acme-events");
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
    const data = (await response.json()) as any;

    expect(response.status).toBe(201);
    expect(data.message).toBe("Account created successfully");
    expect(data.user.email).toBe("newuser@example.com");
    expect(data.user.name).toBe("New User");
    expect(data.user.role).toBe("USER");
  });

  it("successfully registers a vendor with businessName", async () => {
    mockDb.limit.mockResolvedValue([]);
    // A resolved promise that ALSO carries onConflictDoNothing: the plain
    // inserts `await .values(...)`, while OPE-237's evidence insert chains
    // `.onConflictDoNothing()` off it. Without the method the evidence write
    // would throw into its fail-soft catch and this test would assert against
    // a write that never actually completed.
    mockDb.values.mockImplementation(() =>
      Object.assign(Promise.resolve(undefined), {
        onConflictDoNothing: () => Promise.resolve(undefined),
      })
    );

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
    const data = (await response.json()) as any;

    expect(response.status).toBe(201);
    expect(data.user.role).toBe("VENDOR");
    // user + user_roles + vendor + verificationTokens + OPE-237 realness
    // evidence. The user_roles insert was added in the dual-role-foundation
    // PR — it mirrors the primary role into the many-to-many table so
    // dual-role checks via hasRole() / session.user.roles[] honor it.
    expect(mockDb.insert).toHaveBeenCalledTimes(5);

    // OPE-237 — assert WHAT the extra insert is, not just that the count grew.
    // A bare count bump would still pass if the evidence row silently stopped
    // being written and something else started writing instead.
    const evidence = mockDb.values.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((row) => typeof row?.band === "string" && "corroboration" in row);
    expect(evidence, "expected a vendor_claim_evidence row").toBeDefined();
    expect(evidence!.businessName).toBe("My Vendor Business");
    expect(evidence!.claimantEmail).toBe("vendor@example.com");
    // Unchecked, not clean — and pessimistic until email verification lands.
    expect(evidence!.corroboration).toBe("UNAVAILABLE");
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
    const data = (await response.json()) as any;

    expect(response.status).toBe(201);
    expect(data.user.role).toBe("PROMOTER");
    // user + user_roles + promoter + verificationTokens. user_roles
    // mirror added in dual-role-foundation PR.
    expect(mockDb.insert).toHaveBeenCalledTimes(4);
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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

    expect(response.status).toBe(500);
    expect(data.error).toContain("error occurred");
  });
});
