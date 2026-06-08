import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocks need to be hoisted ABOVE the dynamic import — vi.mock is auto-hoisted
// per Vitest's transform pipeline.

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: vi.fn(() => ({ GOOGLE_MAPS_API_KEY: "TEST_KEY" })),
  getCloudflareDb: vi.fn(() => ({})),
}));

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(async () => {}),
}));

// Captured fetch mock so each test can inspect what URL the route built
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("/api/static-map proxy", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("rejects requests missing lat/lng", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      new Request("https://test/api/static-map") as unknown as Parameters<typeof GET>[0]
    );
    expect(res.status).toBe(400);
  });

  it("rejects lat outside [-90, 90]", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      new Request("https://test/api/static-map?lat=91&lng=0") as unknown as Parameters<
        typeof GET
      >[0]
    );
    expect(res.status).toBe(400);
  });

  it("rejects lng outside [-180, 180]", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      new Request("https://test/api/static-map?lat=0&lng=181") as unknown as Parameters<
        typeof GET
      >[0]
    );
    expect(res.status).toBe(400);
  });

  it("clamps zoom + width + height to safe ranges", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(["fake png"]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );
    const { GET } = await import("../route");
    await GET(
      new Request(
        "https://test/api/static-map?lat=44&lng=-70&zoom=99&w=2000&h=2000"
      ) as unknown as Parameters<typeof GET>[0]
    );
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    // Google's max zoom is 21 (route clamps there)
    expect(url.searchParams.get("zoom")).toBe("21");
    // Google's free-tier max size is 640
    expect(url.searchParams.get("size")).toBe("640x640");
  });

  it("constructs a valid Google Static Maps URL with key + pin", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(["fake png"]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );
    const { GET } = await import("../route");
    await GET(
      new Request("https://test/api/static-map?lat=44.0029&lng=-70.4292") as unknown as Parameters<
        typeof GET
      >[0]
    );
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.host).toBe("maps.googleapis.com");
    expect(url.searchParams.get("center")).toBe("44.0029,-70.4292");
    expect(url.searchParams.get("key")).toBe("TEST_KEY");
    expect(url.searchParams.get("markers")).toBe("color:red|44.0029,-70.4292");
    // Default zoom 15, default 2x scale
    expect(url.searchParams.get("zoom")).toBe("15");
    expect(url.searchParams.get("scale")).toBe("2");
  });

  it("forces scale to 1 or 2 (rejects other values)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(["fake png"]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );
    const { GET } = await import("../route");
    await GET(
      new Request("https://test/api/static-map?lat=0&lng=0&scale=4") as unknown as Parameters<
        typeof GET
      >[0]
    );
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    // Anything other than 1 → coerces to 2 (the print-friendly default)
    expect(url.searchParams.get("scale")).toBe("2");
  });

  it("returns 200 + sets immutable cache header on upstream success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(["fake png"]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    );
    const { GET } = await import("../route");
    const res = await GET(
      new Request("https://test/api/static-map?lat=44&lng=-70") as unknown as Parameters<
        typeof GET
      >[0]
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("returns 404 (not 500) when upstream errors so client can fall back", async () => {
    fetchMock.mockResolvedValueOnce(new Response("OVER_QUERY_LIMIT", { status: 403 }));
    const { GET } = await import("../route");
    const res = await GET(
      new Request("https://test/api/static-map?lat=44&lng=-70") as unknown as Parameters<
        typeof GET
      >[0]
    );
    // 404 is the documented "graceful degrade" status — the PrintEventMap
    // <img> renders alt text + the print sheet still has the QR + address
    // fallback for directions.
    expect(res.status).toBe(404);
  });
});
