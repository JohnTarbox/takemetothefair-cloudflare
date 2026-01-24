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
    const promoter = await prisma.promoter.findUnique({
      where: { userId: session.user.id },
    });

    if (!promoter) {
      return NextResponse.json({ error: "Promoter profile not found" }, { status: 404 });
    }

    const events = await prisma.event.findMany({
      where: { promoterId: promoter.id },
      include: {
        venue: { select: { name: true } },
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
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const promoter = await prisma.promoter.findUnique({
      where: { userId: session.user.id },
    });

    if (!promoter) {
      return NextResponse.json(
        { error: "Promoter profile not found. Please complete your profile first." },
        { status: 404 }
      );
    }

    const body = await request.json();
    const {
      name,
      description,
      venueId,
      startDate,
      endDate,
      categories,
      tags,
      ticketUrl,
      ticketPriceMin,
      ticketPriceMax,
      imageUrl,
    } = body;

    let slug = createSlug(name);
    const existingEvent = await prisma.event.findUnique({ where: { slug } });
    if (existingEvent) {
      slug = `${slug}-${Date.now()}`;
    }

    const event = await prisma.event.create({
      data: {
        name,
        slug,
        description,
        venueId,
        promoterId: promoter.id,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        categories: categories || [],
        tags: tags || [],
        ticketUrl,
        ticketPriceMin,
        ticketPriceMax,
        imageUrl,
        status: "PENDING",
      },
    });

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    console.error("Failed to create event:", error);
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
