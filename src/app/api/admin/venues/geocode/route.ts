import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { geocodeAddress } from "@/lib/google-maps";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    address: string;
    city: string;
    state: string;
    zip?: string;
  };

  if (!body.address || !body.city || !body.state) {
    return NextResponse.json(
      { error: "Address, city, and state are required" },
      { status: 400 }
    );
  }

  const result = await geocodeAddress(body.address, body.city, body.state, body.zip);
  if (!result) {
    return NextResponse.json(
      { error: "Could not geocode this address. Check the address and try again." },
      { status: 404 }
    );
  }

  return NextResponse.json(result);
}
