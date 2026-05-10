// Tier-2 FAQ extractor for pillar blog posts. Detects the Q&A structure
// described in MMATF-FAQ-Strategy.md §4.2:
//
//   ## Q: How do I find craft fairs near me?
//   [answer paragraphs]
//
//   ## Q: When should I start applying for fall shows?
//   [answer paragraphs]
//
// Pure function — same shape as src/lib/event-faq.ts so the same
// FAQPageSchema component can render either source. Returns [] (which
// FAQPageSchema renders as null) when fewer than FAQ_MIN_ITEMS Q&A pairs
// are found, so non-FAQ posts emit no schema.
//
// Skips ATX-style headings inside fenced code blocks, matching
// `extractHeadings` from src/lib/markdown-utils.ts.

import { stripMarkdown } from "@/lib/markdown-utils";
import { FAQ_MIN_ITEMS, type FaqItem } from "@/lib/event-faq";

// Match `## Q:` (with optional space variations) at line start. We match
// only H2 to mirror the doc's example structure; H3 Q-headings would be
// sub-questions and shouldn't dilute the top-level FAQ schema.
const Q_HEADING = /^##\s+Q\s*:\s*(.+?)\s*#*$/;

// Cap matches Google's ~10-pair limit (also used in event-faq.ts).
const MAX_ITEMS = 10;

export function extractBlogFaqItems(body: string | null | undefined): FaqItem[] {
  if (!body) return [];

  const lines = body.split("\n");
  const items: FaqItem[] = [];

  let inFence = false;
  let currentQuestion: string | null = null;
  let currentAnswerLines: string[] = [];

  const flush = () => {
    if (currentQuestion === null) return;
    const answerRaw = currentAnswerLines.join("\n").trim();
    const answer = stripMarkdown(answerRaw).trim();
    if (answer.length > 0) {
      items.push({ question: currentQuestion, answer });
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

    const qMatch = line.match(Q_HEADING);
    if (qMatch) {
      flush();
      currentQuestion = qMatch[1].trim();
      continue;
    }

    // Any other H1/H2 ends the current Q&A region — H3+ stay inside the
    // answer (sub-headings within an answer section).
    if (/^#{1,2}\s+/.test(line)) {
      flush();
      continue;
    }

    if (currentQuestion !== null) {
      currentAnswerLines.push(raw);
    }
  }

  flush();

  if (items.length < FAQ_MIN_ITEMS) return [];
  return items.slice(0, MAX_ITEMS);
}
