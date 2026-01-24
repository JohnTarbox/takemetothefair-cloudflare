import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createSlug } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const venues = await prisma.venue.findMany({
      include: {
        _count: { select: { events: true } },
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(venues);
  } catch (error) {
    console.error("Failed to fetch venues:", error);
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      name,
      address,
      city,
      state,
      zip,
      latitude,
      longitude,
      capacity,
      amenities,
      contactEmail,
      contactPhone,
      website,
      description,
      imageUrl,
      status,
    } = body;

    const venue = await prisma.venue.create({
      data: {
        name,
        slug: createSlug(name),
        address,
        city,
        state,
        zip,
        latitude,
        longitude,
        capacity,
        amenities: amenities || [],
        contactEmail,
        contactPhone,
        website,
        description,
        imageUrl,
        status: status || "ACTIVE",
      },
    });

    return NextResponse.json(venue, { status: 201 });
  } catch (error) {
    console.error("Failed to create venue:", error);
    return NextResponse.json({ error: "Failed to create venue" }, { status: 500 });
  }
}
