import { describe, it, expect } from "vitest";
import { extractOgImage, urlLooksLikeJunk } from "../og-image";

describe("extractOgImage", () => {
  it("extracts og:image with property-first attribute order", () => {
    const html = `<html><head><meta property="og:image" content="https://example.com/img.jpg" /></head></html>`;
    const r = extractOgImage(html, "https://example.com/event");
    expect(r).toEqual({ url: "https://example.com/img.jpg", source: "og:image" });
  });

  it("extracts og:image with content-first attribute order", () => {
    const html = `<html><head><meta content="https://example.com/img.jpg" property="og:image" /></head></html>`;
    const r = extractOgImage(html, "https://example.com/event");
    expect(r).toEqual({ url: "https://example.com/img.jpg", source: "og:image" });
  });

  it("falls back to twitter:image when og:image is missing", () => {
    const html = `<html><head><meta name="twitter:image" content="https://example.com/tw.jpg" /></head></html>`;
    const r = extractOgImage(html, "https://example.com/event");
    expect(r).toEqual({ url: "https://example.com/tw.jpg", source: "twitter:image" });
  });

  it("prefers og:image over twitter:image when both present", () => {
    const html = `
      <meta property="og:image" content="https://example.com/og.jpg" />
      <meta name="twitter:image" content="https://example.com/tw.jpg" />
    `;
    const r = extractOgImage(html, "https://example.com/event");
    expect(r?.url).toBe("https://example.com/og.jpg");
    expect(r?.source).toBe("og:image");
  });

  it("resolves relative URLs against the page URL", () => {
    const html = `<meta property="og:image" content="/static/img.jpg" />`;
    const r = extractOgImage(html, "https://example.com/event/123");
    expect(r?.url).toBe("https://example.com/static/img.jpg");
  });

  it("rejects data: URIs", () => {
    const html = `<meta property="og:image" content="data:image/png;base64,iVBORw0KGgo=" />`;
    const r = extractOgImage(html, "https://example.com/event");
    expect(r).toBeNull();
  });

  it("returns null when neither tag is present", () => {
    const html = `<html><head><title>No meta</title></head></html>`;
    expect(extractOgImage(html, "https://example.com/event")).toBeNull();
  });

  it("handles single-quoted attributes", () => {
    const html = `<meta property='og:image' content='https://example.com/img.jpg' />`;
    const r = extractOgImage(html, "https://example.com/event");
    expect(r?.url).toBe("https://example.com/img.jpg");
  });
});

describe("urlLooksLikeJunk", () => {
  it("flags Google Calendar add buttons", () => {
    expect(urlLooksLikeJunk("https://calendar.google.com/calendar/event?text=...")).toBe(true);
    expect(urlLooksLikeJunk("https://example.com/addtocalendar.png")).toBe(true);
  });

  it("flags tracking pixels", () => {
    expect(urlLooksLikeJunk("https://example.com/1x1.gif")).toBe(true);
    expect(urlLooksLikeJunk("https://example.com/spacer.png")).toBe(true);
    expect(urlLooksLikeJunk("https://example.com/pixel.gif")).toBe(true);
  });

  it("flags doubleclick / googlesyndication tracking", () => {
    expect(urlLooksLikeJunk("https://ad.doubleclick.net/foo.png")).toBe(true);
    expect(urlLooksLikeJunk("https://pagead2.googlesyndication.com/x.gif")).toBe(true);
  });

  it("passes through legitimate event images", () => {
    expect(urlLooksLikeJunk("https://example.com/events/banner.jpg")).toBe(false);
    expect(urlLooksLikeJunk("https://capecodchamber.org/uploads/event.jpg")).toBe(false);
    expect(urlLooksLikeJunk("https://cdn.example.com/img/hero-photo.jpg")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(urlLooksLikeJunk("https://example.com/SPACER.GIF")).toBe(true);
  });
});
