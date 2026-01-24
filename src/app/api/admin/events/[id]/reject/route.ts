import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const event = await prisma.event.update({
      where: { id },
      data: { status: "REJECTED" },
    });

    return NextResponse.json(event);
  } catch (error) {
    console.error("Failed to reject event:", error);
    return NextResponse.json({ error: "Failed to reject event" }, { status: 500 });
  }
}
