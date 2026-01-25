import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users, promoters, vendors } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth";
import { createSlug } from "@/lib/utils";
import { eq } from "drizzle-orm";

export const runtime = "edge";


const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  role: z.enum(["USER", "PROMOTER", "VENDOR"]).optional().default("USER"),
  companyName: z.string().optional(),
  businessName: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const validation = registerSchema.safeParse(body);

    if (!validation.success) {
      const issues = validation.error.issues;
      return NextResponse.json(
        { error: issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const { email, password, name, role, companyName, businessName } =
      validation.data;

    const db = getCloudflareDb();

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existingUser.length > 0) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();

    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      name,
      role,
    });

    if (role === "PROMOTER" && companyName) {
      await db.insert(promoters).values({
        id: crypto.randomUUID(),
        userId,
        companyName,
        slug: createSlug(companyName),
      });
    }

    if (role === "VENDOR" && businessName) {
      await db.insert(vendors).values({
        id: crypto.randomUUID(),
        userId,
        businessName,
        slug: createSlug(businessName),
      });
    }

    return NextResponse.json(
      {
        message: "Account created successfully",
        user: {
          id: userId,
          email,
          name,
          role,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "An error occurred during registration" },
      { status: 500 }
    );
  }
}
