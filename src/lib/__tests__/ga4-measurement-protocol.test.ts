import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  parseGaClientId,
  safeHostname,
  sendGa4MeasurementProtocol,
} from "../ga4-measurement-protocol";

describe("parseGaClientId", () => {
  it("extracts the trailing two segments from a _ga cookie", () => {
    expect(parseGaClientId("_ga=GA1.1.123456789.1700000000")).toBe("123456789.1700000000");
  });

  it("ignores _ga_<STREAM> session cookies and reads the real _ga", () => {
    const header = "_ga_ABC123=GS1.1.foo; _ga=GA1.2.987.654; other=x";
    expect(parseGaClientId(header)).toBe("987.654");
  });

  it("returns null for a missing cookie header", () => {
    expect(parseGaClientId(null)).toBeNull();
  });

  it("returns null when _ga is absent", () => {
    expect(parseGaClientId("foo=bar; baz=qux")).toBeNull();
  });

  it("returns null for a malformed _ga value", () => {
    expect(parseGaClientId("_ga=GA1.1")).toBeNull();
  });
});

describe("safeHostname", () => {
  it("returns the hostname for a valid URL", () => {
    expect(safeHostname("https://tickets.example.com/buy?id=5")).toBe("tickets.example.com");
  });

  it("returns empty string for an unparseable value", () => {
    expect(safeHostname("not a url")).toBe("");
    expect(safeHostname("")).toBe("");
  });
});

describe("sendGa4MeasurementProtocol", () => {
  const mockedCtx = vi.mocked(getCloudflareContext);
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockedCtx.mockReset();
  });

  function withEnv(env: Record<string, unknown>) {
    mockedCtx.mockReturnValue({ env } as never);
  }

  it("no-ops (no fetch) when GA4 env vars are unset", async () => {
    withEnv({});
    await sendGa4MeasurementProtocol("1.2", [{ name: "x", params: {} }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when only the measurement id is set", async () => {
    withEnv({ GA4_MEASUREMENT_ID: "G-TEST" });
    await sendGa4MeasurementProtocol("1.2", [{ name: "x", params: {} }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops for an empty events array even when configured", async () => {
    withEnv({ GA4_MEASUREMENT_ID: "G-TEST", GA4_MP_API_SECRET: "sek" });
    await sendGa4MeasurementProtocol("1.2", []);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs the client_id + events to the MP endpoint when configured", async () => {
    withEnv({ GA4_MEASUREMENT_ID: "G-TEST", GA4_MP_API_SECRET: "sek" });
    const events = [{ name: "outbound_ticket_click", params: { entity_type: "event" } }];
    await sendGa4MeasurementProtocol("123.456", events);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("https://www.google-analytics.com/mp/collect");
    expect(url).toContain("measurement_id=G-TEST");
    expect(url).toContain("api_secret=sek");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ client_id: "123.456", events });
  });

  it("never throws when fetch rejects", async () => {
    withEnv({ GA4_MEASUREMENT_ID: "G-TEST", GA4_MP_API_SECRET: "sek" });
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    await expect(
      sendGa4MeasurementProtocol("1.2", [{ name: "x", params: {} }])
    ).resolves.toBeUndefined();
  });
});
