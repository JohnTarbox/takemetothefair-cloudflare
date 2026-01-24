import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { createSlug } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status");

  const where = status ? { status: status as "PENDING" | "APPROVED" | "REJECTED" | "DRAFT" | "CANCELLED" } : {};

  try {
    const events = await prisma.event.findMany({
      where,
      include: {
        venue: { select: { name: true } },
        promoter: { select: { companyName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(events);
  } catch (error) {
    console.error("Failed to fetch events:", error);
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
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
      description,
      venueId,
      promoterId,
      startDate,
      endDate,
      categories,
      tags,
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
      featured,
      status,
    } = body;

    const event = await prisma.event.create({
      data: {
        name,
        slug: createSlug(name),
        description,
        venueId,
        promoterId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        categories: categories || [],
        tags: tags || [],
        ticketUrl,
        ticketPriceMin,
        ticketPriceMax,
        imageUrl,
        featured: featured || false,
        status: status || "APPROVED",
      },
    });

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    console.error("Failed to create event:", error);
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
