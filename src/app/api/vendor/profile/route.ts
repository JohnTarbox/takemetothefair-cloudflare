import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createSlug } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const vendor = await prisma.vendor.findUnique({
      where: { userId: session.user.id },
    });

    if (!vendor) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    return NextResponse.json(vendor);
  } catch (error) {
    console.error("Failed to fetch vendor profile:", error);
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { businessName, description, vendorType, products, website, logoUrl } =
      body;

    const updateData: Record<string, unknown> = {};
    if (businessName) {
      updateData.businessName = businessName;
      updateData.slug = createSlug(businessName);
    }
    if (description !== undefined) updateData.description = description;
    if (vendorType !== undefined) updateData.vendorType = vendorType;
    if (products) updateData.products = products;
    if (website !== undefined) updateData.website = website;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;

    const vendor = await prisma.vendor.update({
      where: { userId: session.user.id },
      data: updateData,
    });

    return NextResponse.json(vendor);
  } catch (error) {
    console.error("Failed to update vendor profile:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
