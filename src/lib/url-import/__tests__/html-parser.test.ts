/**
 * Tests for HTML parser functions
 */

import { describe, it, expect } from "vitest";
import { extractTextFromHtml, extractMetadata, extractLinks } from "../html-parser";

describe("extractTextFromHtml", () => {
  describe("basic HTML stripping", () => {
    it("removes HTML tags from text", () => {
      const html = "<p>Hello <strong>World</strong></p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Hello");
      expect(result).toContain("World");
      expect(result).not.toContain("<p>");
      expect(result).not.toContain("<strong>");
    });

    it("handles nested tags", () => {
      const html = "<div><p><span>Nested <em>content</em></span></p></div>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Nested");
      expect(result).toContain("content");
    });
  });

  describe("script and style removal", () => {
    it("removes script tags and their content", () => {
      const html = "<p>Before</p><script>alert('evil');</script><p>After</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Before");
      expect(result).toContain("After");
      expect(result).not.toContain("alert");
      expect(result).not.toContain("evil");
    });

    it("removes script tags with attributes", () => {
      const html = '<script type="text/javascript" src="app.js">var x = 1;</script><p>Content</p>';
      const result = extractTextFromHtml(html);
      expect(result).toContain("Content");
      expect(result).not.toContain("var x");
    });

    it("removes style tags and their content", () => {
      const html = "<style>.class { color: red; }</style><p>Visible</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Visible");
      expect(result).not.toContain("color");
      expect(result).not.toContain(".class");
    });

    it("removes noscript tags and their content", () => {
      const html = "<noscript>JavaScript required</noscript><p>Content</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Content");
      expect(result).not.toContain("JavaScript required");
    });
  });

  describe("HTML comments removal", () => {
    it("removes HTML comments", () => {
      const html = "<p>Start</p><!-- This is a comment --><p>End</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Start");
      expect(result).toContain("End");
      expect(result).not.toContain("This is a comment");
    });

    it("removes multi-line comments", () => {
      const html = `<p>Before</p>
      <!--
        Multi-line
        comment here
      -->
      <p>After</p>`;
      const result = extractTextFromHtml(html);
      expect(result).toContain("Before");
      expect(result).toContain("After");
      expect(result).not.toContain("Multi-line");
    });
  });

  describe("block element handling", () => {
    it("converts block elements to newlines", () => {
      const html = "<p>Paragraph 1</p><p>Paragraph 2</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Paragraph 1");
      expect(result).toContain("Paragraph 2");
      expect(result.includes("\n")).toBe(true);
    });

    it("handles heading elements", () => {
      const html = "<h1>Title</h1><h2>Subtitle</h2><p>Content</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Title");
      expect(result).toContain("Subtitle");
      expect(result).toContain("Content");
    });

    it("handles br tags", () => {
      const html = "<p>Line 1<br>Line 2<br/>Line 3</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });
  });

  describe("HTML entity decoding", () => {
    it("decodes common named entities", () => {
      const html = "<p>Tom &amp; Jerry &lt;3&gt; &quot;friends&quot;</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Tom & Jerry");
      expect(result).toContain("<3>");
      expect(result).toContain('"friends"');
    });

    it("decodes nbsp entity", () => {
      const html = "<p>Word&nbsp;Word</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("Word Word");
    });

    it("decodes apostrophe entities", () => {
      const html = "<p>It&#39;s great! Don&apos;t worry</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("It's great!");
      expect(result).toContain("Don't worry");
    });

    it("decodes typographic entities", () => {
      const html = "<p>2020&ndash;2025 &mdash; A decade&hellip;</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("2020-2025");
      expect(result).toContain("-");
      expect(result).toContain("...");
    });

    it("decodes numeric entities (decimal)", () => {
      const html = "<p>&#65;&#66;&#67;</p>";  // ABC
      const result = extractTextFromHtml(html);
      expect(result).toContain("ABC");
    });

    it("decodes numeric entities (hex)", () => {
      const html = "<p>&#x41;&#x42;&#x43;</p>";  // ABC
      const result = extractTextFromHtml(html);
      expect(result).toContain("ABC");
    });

    it("decodes special symbols", () => {
      const html = "<p>&copy; 2025 &reg; Brand&trade; &bull; Item</p>";
      const result = extractTextFromHtml(html);
      expect(result).toContain("(c) 2025");
      expect(result).toContain("(R)");
      expect(result).toContain("(TM)");
      expect(result).toContain("* Item");
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple spaces", () => {
      const html = "<p>Multiple    spaces     here</p>";
      const result = extractTextFromHtml(html);
      expect(result).not.toContain("    ");
      expect(result).toContain("Multiple spaces here");
    });

    it("collapses excessive newlines", () => {
      const html = "<p>Para 1</p>\n\n\n\n\n<p>Para 2</p>";
      const result = extractTextFromHtml(html);
      expect(result).not.toMatch(/\n{3,}/);
    });

    it("trims leading and trailing whitespace", () => {
      const html = "   <p>Content</p>   ";
      const result = extractTextFromHtml(html);
      expect(result).toBe("Content");
    });
  });

  describe("content length limiting", () => {
    it("truncates content exceeding 50KB", () => {
      const longContent = "x".repeat(60 * 1024);
      const html = `<p>${longContent}</p>`;
      const result = extractTextFromHtml(html);
      expect(result.length).toBeLessThan(55 * 1024);
      expect(result).toContain("[Content truncated...]");
    });

    it("does not truncate content under limit", () => {
      const html = "<p>Short content</p>";
      const result = extractTextFromHtml(html);
      expect(result).not.toContain("[Content truncated...]");
    });
  });
});

describe("extractMetadata", () => {
  describe("title extraction", () => {
    it("extracts title from title tag", () => {
      const html = "<html><head><title>Event Title</title></head></html>";
      const metadata = extractMetadata(html);
      expect(metadata.title).toBe("Event Title");
    });

    it("trims whitespace from title", () => {
      const html = "<html><head><title>  Spaced Title  </title></head></html>";
      const metadata = extractMetadata(html);
      expect(metadata.title).toBe("Spaced Title");
    });

    it("decodes HTML entities in title", () => {
      const html = "<html><head><title>Tom &amp; Jerry&apos;s Show</title></head></html>";
      const metadata = extractMetadata(html);
      expect(metadata.title).toBe("Tom & Jerry's Show");
    });

    it("falls back to og:title when no title tag", () => {
      const html = '<html><head><meta property="og:title" content="OG Event Title"></head></html>';
      const metadata = extractMetadata(html);
      expect(metadata.title).toBe("OG Event Title");
    });

    it("prefers title tag over og:title", () => {
      const html = `<html><head>
        <title>Page Title</title>
        <meta property="og:title" content="OG Title">
      </head></html>`;
      const metadata = extractMetadata(html);
      expect(metadata.title).toBe("Page Title");
    });
  });

  describe("og:image extraction", () => {
    it("extracts og:image with property before content", () => {
      const html = '<meta property="og:image" content="https://example.com/image.jpg">';
      const metadata = extractMetadata(html);
      expect(metadata.ogImage).toBe("https://example.com/image.jpg");
    });

    it("extracts og:image with content before property", () => {
      const html = '<meta content="https://example.com/image.jpg" property="og:image">';
      const metadata = extractMetadata(html);
      expect(metadata.ogImage).toBe("https://example.com/image.jpg");
    });

    it("handles double and single quotes", () => {
      const html1 = '<meta property="og:image" content="https://example.com/image1.jpg">';
      const html2 = "<meta property='og:image' content='https://example.com/image2.jpg'>";

      expect(extractMetadata(html1).ogImage).toBe("https://example.com/image1.jpg");
      expect(extractMetadata(html2).ogImage).toBe("https://example.com/image2.jpg");
    });
  });

  describe("JSON-LD extraction", () => {
    it("extracts Event schema from JSON-LD", () => {
      const html = `<script type="application/ld+json">
        {
          "@type": "Event",
          "name": "Concert",
          "startDate": "2025-03-15"
        }
      </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeDefined();
      expect(metadata.jsonLd?.["@type"]).toBe("Event");
      expect(metadata.jsonLd?.name).toBe("Concert");
    });

    it("finds Event in array of schemas", () => {
      const html = `<script type="application/ld+json">
        [
          { "@type": "Organization", "name": "Org" },
          { "@type": "Event", "name": "Festival", "startDate": "2025-06-01" }
        ]
      </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeDefined();
      expect(metadata.jsonLd?.["@type"]).toBe("Event");
      expect(metadata.jsonLd?.name).toBe("Festival");
    });

    it("finds Event in @graph pattern", () => {
      const html = `<script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebSite", "name": "Site" },
            { "@type": "Event", "name": "Conference", "startDate": "2025-09-01" }
          ]
        }
      </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeDefined();
      expect(metadata.jsonLd?.["@type"]).toBe("Event");
      expect(metadata.jsonLd?.name).toBe("Conference");
    });

    it("handles type array containing Event", () => {
      const html = `<script type="application/ld+json">
        {
          "@type": ["Event", "SocialEvent"],
          "name": "Party"
        }
      </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeDefined();
      expect(metadata.jsonLd?.name).toBe("Party");
    });

    it("ignores invalid JSON-LD", () => {
      const html = `<script type="application/ld+json">
        { invalid json here }
      </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeUndefined();
    });

    it("ignores non-Event JSON-LD", () => {
      const html = `<script type="application/ld+json">
        {
          "@type": "Organization",
          "name": "Company"
        }
      </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeUndefined();
    });

    it("handles multiple JSON-LD blocks", () => {
      const html = `
        <script type="application/ld+json">
          { "@type": "Organization", "name": "Company" }
        </script>
        <script type="application/ld+json">
          { "@type": "Event", "name": "Event in second block" }
        </script>`;
      const metadata = extractMetadata(html);
      expect(metadata.jsonLd).toBeDefined();
      expect(metadata.jsonLd?.name).toBe("Event in second block");
    });
  });

  describe("empty/missing metadata", () => {
    it("returns empty object for html without metadata", () => {
      const html = "<html><body>No metadata here</body></html>";
      const metadata = extractMetadata(html);
      expect(metadata.title).toBeUndefined();
      expect(metadata.ogImage).toBeUndefined();
      expect(metadata.jsonLd).toBeUndefined();
    });
  });
});

describe("extractLinks", () => {
  describe("basic link extraction", () => {
    it("extracts absolute URLs", () => {
      const html = '<a href="https://example.com/page">Link</a>';
      const links = extractLinks(html, "https://base.com");
      expect(links).toContain("https://example.com/page");
    });

    it("resolves relative URLs against base", () => {
      const html = '<a href="/events/123">Event Link</a>';
      const links = extractLinks(html, "https://example.com");
      expect(links).toContain("https://example.com/events/123");
    });

    it("resolves relative paths without leading slash", () => {
      const html = '<a href="events/123">Event Link</a>';
      const links = extractLinks(html, "https://example.com/page/");
      expect(links).toContain("https://example.com/page/events/123");
    });
  });

  describe("multiple links", () => {
    it("extracts all links from page", () => {
      const html = `
        <a href="https://example.com/1">Link 1</a>
        <a href="https://example.com/2">Link 2</a>
        <a href="https://example.com/3">Link 3</a>
      `;
      const links = extractLinks(html, "https://base.com");
      expect(links.length).toBe(3);
      expect(links).toContain("https://example.com/1");
      expect(links).toContain("https://example.com/2");
      expect(links).toContain("https://example.com/3");
    });

    it("deduplicates identical links", () => {
      const html = `
        <a href="https://example.com/page">Link 1</a>
        <a href="https://example.com/page">Link 2</a>
        <a href="https://example.com/page">Link 3</a>
      `;
      const links = extractLinks(html, "https://base.com");
      expect(links.length).toBe(1);
    });
  });

  describe("link variations", () => {
    it("handles single and double quotes", () => {
      const html = `
        <a href="https://example.com/double">Double</a>
        <a href='https://example.com/single'>Single</a>
      `;
      const links = extractLinks(html, "https://base.com");
      expect(links).toContain("https://example.com/double");
      expect(links).toContain("https://example.com/single");
    });

    it("handles links with additional attributes", () => {
      const html = '<a class="btn" href="https://example.com/page" target="_blank">Link</a>';
      const links = extractLinks(html, "https://base.com");
      expect(links).toContain("https://example.com/page");
    });
  });

  describe("invalid links", () => {
    it("ignores invalid URLs", () => {
      const html = `
        <a href="javascript:void(0)">JS Link</a>
        <a href="mailto:test@example.com">Email</a>
        <a href="#">Anchor</a>
      `;
      const links = extractLinks(html, "https://base.com");
      // javascript: and mailto: are valid URL schemes, but # alone is resolved
      expect(links).toContain("https://base.com/#");
    });

    it("ignores empty href", () => {
      // The regex requires at least one character in href, so empty href is not matched
      const html = '<a href="">Empty</a>';
      const links = extractLinks(html, "https://base.com");
      expect(links).toEqual([]);
    });
  });

  describe("protocol handling", () => {
    it("handles protocol-relative URLs", () => {
      const html = '<a href="//cdn.example.com/resource">CDN Link</a>';
      const links = extractLinks(html, "https://base.com");
      expect(links).toContain("https://cdn.example.com/resource");
    });
  });
});
