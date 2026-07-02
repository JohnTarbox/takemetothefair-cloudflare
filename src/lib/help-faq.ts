/**
 * FAQ extractor for the `/help/faq` help article (OPE-62).
 *
 * The help FAQ body uses a DIFFERENT heading shape than the blog FAQ
 * (`src/lib/blog-faq.ts`): each question is an H3 `### Question?` heading
 * followed by the answer prose, rather than the blog's `## Q:` H2 shape. So
 * this needs its own parser — but it returns the same `FaqItem` shape
 * (`{ question, answer }`) that `FAQPageSchema` consumes, and it reuses the
 * shared `stripMarkdown` helper for answer text (same as `extractBlogFaqItems`).
 *
 *   ### What is Meet Me at the Fair?
 *   [answer paragraphs]
 *
 *   ### Is it free?
 *   [answer paragraphs]
 *
 * Each `### heading` becomes a question; the prose up to the next H1/H2/H3 is
 * its answer, run through `stripMarkdown` and trimmed. Answers that are empty
 * after stripping are skipped. A body with no `###` headings returns `[]`
 * (which `FAQPageSchema` renders as `null`). ATX headings inside fenced code
 * blocks are ignored, mirroring `extractBlogFaqItems`.
 *
 * Unlike the blog extractor, this does NOT apply the FAQ_MIN_ITEMS floor — the
 * caller decides whether to emit. The deploy-time validator
 * (`scripts/check-event-jsonld-fields.ts`) asserts the real `faq` article
 * parses to ≥3 populated pairs so malformed help JSON-LD fails the build.
 */

import { stripMarkdown } from "@/lib/markdown-utils";
import type { FaqItem } from "@/lib/event-faq";

// Match an H3 `### question` heading at line start (optional trailing #'s).
const H3_HEADING = /^###\s+(.+?)\s*#*$/;

export function extractHelpFaqItems(body: string | null | undefined): FaqItem[] {
  if (!body) return [];

  const lines = body.split("\n");
  const items: FaqItem[] = [];

  let inFence = false;
  let currentQuestion: string | null = null;
  let currentAnswerLines: string[] = [];

  const flush = () => {
    if (currentQuestion === null) return;
    const answer = stripMarkdown(currentAnswerLines.join("\n").trim()).trim();
    const question = currentQuestion.trim();
    if (question.length > 0 && answer.length > 0) {
      items.push({ question, answer });
    }
    currentQuestion = null;
    currentAnswerLines = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^```/.test(line)) {
      inFence = !inFence;
      if (currentQuestion !== null) currentAnswerLines.push(raw);
      continue;
    }

    if (inFence) {
      if (currentQuestion !== null) currentAnswerLines.push(raw);
      continue;
    }

    const h3Match = line.match(H3_HEADING);
    if (h3Match) {
      flush();
      currentQuestion = h3Match[1].trim();
      continue;
    }

    // Any H1/H2 ends the current Q&A region (a new top-level section).
    if (/^#{1,2}\s+/.test(line)) {
      flush();
      continue;
    }

    if (currentQuestion !== null) {
      currentAnswerLines.push(raw);
    }
  }

  flush();

  return items;
}
