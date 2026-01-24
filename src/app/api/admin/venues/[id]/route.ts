import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createSlug } from "@/lib/utils";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const venue = await prisma.venue.findUnique({
      where: { id },
      include: {
        events: {
          orderBy: { startDate: "desc" },
          take: 10,
        },
      },
    });

    if (!venue) {
      return NextResponse.json({ error: "Venue not found" }, { status: 404 });
    }

    return NextResponse.json(venue);
  } catch (error) {
    console.error("Failed to fetch venue:", error);
    return NextResponse.json({ error: "Failed to fetch venue" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

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

    const updateData: Record<string, unknown> = {};
    if (name) {
      updateData.name = name;
      updateData.slug = createSlug(name);
    }
    if (address) updateData.address = address;
    if (city) updateData.city = city;
    if (state) updateData.state = state;
    if (zip) updateData.zip = zip;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (capacity !== undefined) updateData.capacity = capacity;
    if (amenities) updateData.amenities = amenities;
    if (contactEmail !== undefined) updateData.contactEmail = contactEmail;
    if (contactPhone !== undefined) updateData.contactPhone = contactPhone;
    if (website !== undefined) updateData.website = website;
    if (description !== undefined) updateData.description = description;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (status) updateData.status = status;

    const venue = await prisma.venue.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json(venue);
  } catch (error) {
    console.error("Failed to update venue:", error);
    return NextResponse.json({ error: "Failed to update venue" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    await prisma.venue.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete venue:", error);
    return NextResponse.json({ error: "Failed to delete venue" }, { status: 500 });
  }
}
