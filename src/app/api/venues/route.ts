import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const venues = await prisma.venue.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        city: true,
        state: true,
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(venues);
  } catch (error) {
    console.error("Failed to fetch venues:", error);
    return NextResponse.json({ error: "Failed to fetch venues" }, { status: 500 });
  }
}
