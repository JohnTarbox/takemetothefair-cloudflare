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
