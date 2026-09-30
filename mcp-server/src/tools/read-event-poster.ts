/**
 * OPE-940 — `read_event_poster`: a READ-ONLY vision read of one event poster.
 *
 * Built so an unattended sweep can follow its own first rule ("read the actual
 * poster") — see photo/read-poster.ts for why the runner could not. Writes
 * nothing: the reading is a lead to cite with the image URL, never a value to
 * write unreviewed (OPE-969 measured confident misreads from this model).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { fetchImageWithFallback, imageFetchHeaders } from "@takemetothefair/utils";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { events } from "../schema.js";
import {
  POSTER_MAX_BYTES,
  posterDisagreements,
  readPoster,
  type PosterAi,
} from "../photo/read-poster.js";

export function registerReadEventPosterTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: { AI?: unknown }
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "read_event_poster",
    [
      "READ-ONLY. Read one event poster/flyer image with the vision model and return what is",
      "PRINTED on it: dates, hours, price, location and the raw text, plus a confidence.",
      "For organizers who publish event details only as an image (web_fetch returns a poster",
      "as its filename). Pass event_id to also get where the poster DISAGREES with the stored",
      "row — the poster is the value to cite. Writes nothing. Treat the reading as a lead to",
      "cite with image_url, never as a value to write unreviewed: this model can misread",
      "confidently. One image per call, max 10 MB. Admin only.",
    ].join(" "),
    {
      image_url: z.string().url().describe("Publicly fetchable URL of the poster image."),
      event_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional: compare the reading against this event's stored dates and price."),
    },
    async ({ image_url, event_id }) => {
      const ai = env?.AI as PosterAi | undefined;
      if (!ai) {
        return {
          content: [
            { type: "text" as const, text: "The AI binding is not available on this Worker." },
          ],
          isError: true,
        };
      }

      let bytes: Uint8Array;
      try {
        const fetched = await fetchImageWithFallback(async (userAgent) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          try {
            return await fetch(image_url, {
              headers: imageFetchHeaders(userAgent),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
        });
        if (!fetched.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${fetched.verdict.message} Attempts: ${fetched.attempts.join("; ")}.`,
              },
            ],
            isError: true,
          };
        }
        const buf = await fetched.response.arrayBuffer();
        if (buf.byteLength > POSTER_MAX_BYTES) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Image is ${buf.byteLength} bytes; read_event_poster reads at most ${POSTER_MAX_BYTES}.`,
              },
            ],
            isError: true,
          };
        }
        bytes = new Uint8Array(buf);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch image: ${err instanceof Error ? err.message : "unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      const reading = await readPoster(ai, bytes);

      let row: { start_date: string | null; ticket_price_min: number | null } | null = null;
      if (event_id) {
        const [ev] = await db
          .select({ startDate: events.startDate, ticketPriceMinCents: events.ticketPriceMinCents })
          .from(events)
          .where(eq(events.id, event_id))
          .limit(1);
        if (ev) {
          row = {
            start_date: ev.startDate ? new Date(ev.startDate).toISOString().slice(0, 10) : null,
            ticket_price_min:
              ev.ticketPriceMinCents === null || ev.ticketPriceMinCents === undefined
                ? null
                : ev.ticketPriceMinCents / 100,
          };
        }
      }

      return {
        content: [
          jsonContent({
            image_url,
            source_to_cite: image_url,
            reading,
            low_confidence: reading.failure_reason !== null || reading.confidence < 0.5,
            ...(event_id
              ? { event_id, stored: row, disagreements: posterDisagreements(reading, row) }
              : {}),
            note: "Read-only. Cite image_url as the source; do not write these values unreviewed.",
          }),
        ],
      };
    }
  );
}
