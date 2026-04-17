/**
 * Estimate reading time in minutes from Markdown content.
 * Uses 225 words per minute (average reading speed).
 */
export function estimateReadingTime(markdown: string): number {
  const words = markdown.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 225));
}

/**
 * Count words in Markdown content.
 */
export function countWords(markdown: string): number {
  return markdown.trim().split(/\s+/).length;
}

/**
 * Strip Markdown syntax to get plain text (for RSS descriptions, etc.).
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // images
    .replace(/\[[^\]]*\]\([^)]+\)/g, (match) => match.replace(/\[([^\]]*)\]\([^)]+\)/, "$1")) // links → text
    .replace(/#{1,6}\s+/g, "") // headings
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold/italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "") // code
    .replace(/^\s*[-*+]\s+/gm, "") // list markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/>\s+/g, "") // blockquotes
    .replace(/\n{2,}/g, " ") // collapse newlines
    .replace(/\n/g, " ")
    .trim();
}

/**
 * Extract the first image URL from Markdown content.
 * Matches both ![alt](url) syntax and raw <img src="url"> tags.
 */
export function extractFirstImage(markdown: string | null | undefined): string | null {
  if (!markdown) return null;

  // Match Markdown image: ![...](url)
  const mdMatch = markdown.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (mdMatch) return mdMatch[1];

  // Match HTML img tag: <img ... src="url" ...>
  const htmlMatch = markdown.match(/<img[^>]+src=["']([^"']+)["']/);
  if (htmlMatch) return htmlMatch[1];

  return null;
}

/**
 * Slugify a heading into a stable anchor id. Must match the id generator
 * wired into the MarkdownContent renderer so TOC anchors resolve.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // strip punctuation
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface MarkdownHeading {
  level: 2 | 3;
  text: string;
  id: string;
}

/**
 * Extract H2/H3 headings from a markdown body in document order.
 *
 * Ignores ATX-style headings inside fenced code blocks (```), which would
 * otherwise get captured by the simple line-start regex.
 */
export function extractHeadings(markdown: string | null | undefined): MarkdownHeading[] {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const out: MarkdownHeading[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*$/);
    if (!m) continue;
    const level = m[1].length === 2 ? 2 : 3;
    const text = m[2].trim();
    out.push({ level: level as 2 | 3, text, id: headingSlug(text) });
  }
  return out;
}
