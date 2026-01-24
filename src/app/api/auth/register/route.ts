import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { createSlug } from "@/lib/utils";
import { UserRole } from "@prisma/client";

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
    const body = await request.json();
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

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        role: role as UserRole,
      },
    });

    if (role === "PROMOTER" && companyName) {
      await prisma.promoter.create({
        data: {
          userId: user.id,
          companyName,
          slug: createSlug(companyName),
        },
      });
    }

    if (role === "VENDOR" && businessName) {
      await prisma.vendor.create({
        data: {
          userId: user.id,
          businessName,
          slug: createSlug(businessName),
        },
      });
    }

    return NextResponse.json(
      {
        message: "Account created successfully",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
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
