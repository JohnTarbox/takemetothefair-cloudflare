/**
 * OPE-1620 — the promoter API's OpenAPI 3.1 document, served at
 * GET /api/v1/openapi.json. The one source: the field list is built from the
 * spreadsheet template (TEMPLATE_COLUMNS), so the spec cannot drift from the
 * parser. A test asserts every path here exists as a route file.
 */
import { SITE_URL } from "@takemetothefair/constants";
import { TEMPLATE_COLUMNS } from "@/lib/promoter-import/rows";
import { MAX_SKEW_SECONDS, MAX_REQUEST_ID_LENGTH, PROMOTER_API_RATE } from "./auth";

const fieldProps = Object.fromEntries(
  TEMPLATE_COLUMNS.map((c) => [
    c.key,
    c.key === "categories"
      ? {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }],
          description: `${c.header}. A list, or one string separated by ; , or |. Example: "${c.example}". Unknown categories are left off with a warning.`,
        }
      : {
          type: ["string", "number", "null"],
          description: `${c.header}${c.required ? " (required on create)" : ""}. Example: "${c.example}".`,
        },
  ])
);

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const authErrors = {
  "401": errorResponse(
    "Missing auth headers, unknown or revoked key, stale timestamp, or bad signature."
  ),
  "409": errorResponse(
    "Replayed request id, an event another organizer lists, or a create still in progress."
  ),
  "429": {
    ...errorResponse(`Rate limited (${PROMOTER_API_RATE.max} requests per minute per key).`),
    headers: { "Retry-After": { schema: { type: "integer" } } },
  },
};

const externalIdParam = {
  name: "external_id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9._:~-]{1,100}$" },
};

const writeResult = {
  description: "The outcome.",
  content: { "application/json": { schema: { $ref: "#/components/schemas/WriteResult" } } },
};

export const PROMOTER_API_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Meet Me at the Fair — Promoter Events API",
    version: "1.0.0",
    description:
      "Submit and update your own events from your own system. New events are reviewed before they appear. Changes to a listed event are staged for review and never written directly. Listing is free.",
  },
  servers: [{ url: SITE_URL }],
  security: [{ MmatfKey: [], MmatfTimestamp: [], MmatfRequestId: [], MmatfSignature: [] }],
  paths: {
    "/api/v1/promoter/events": {
      get: {
        summary: "List your events by external_id",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "One page, ordered by external_id. Pass next_cursor to get the next page.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RefPage" } },
            },
          },
          ...authErrors,
        },
      },
      post: {
        summary: "Create or update one event by your external_id",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/EventUpsert" } } },
        },
        responses: {
          "200": writeResult,
          "201": writeResult,
          "422": errorResponse("Validation failed; error.errors lists each field."),
          ...authErrors,
        },
      },
    },
    "/api/v1/promoter/events/{external_id}": {
      patch: {
        summary: "Stage a partial update",
        parameters: [externalIdParam],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/EventFields" } } },
        },
        responses: {
          "200": writeResult,
          "404": errorResponse("Unknown external_id for this key's promoter."),
          "422": errorResponse("Validation failed; error.errors lists each field."),
          ...authErrors,
        },
      },
    },
    "/api/v1/promoter/events/{external_id}/cancel": {
      post: {
        summary: "Ask for a cancellation (staged for review)",
        parameters: [externalIdParam],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { reason: { type: "string", maxLength: 500 } },
              },
            },
          },
        },
        responses: {
          "200": writeResult,
          "404": errorResponse("Unknown external_id for this key's promoter."),
          ...authErrors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      MmatfKey: { type: "apiKey", in: "header", name: "X-MMATF-Key" },
      MmatfTimestamp: {
        type: "apiKey",
        in: "header",
        name: "X-MMATF-Timestamp",
        description: `Unix seconds; must be within ${MAX_SKEW_SECONDS} s of our clock.`,
      },
      MmatfRequestId: {
        type: "apiKey",
        in: "header",
        name: "X-MMATF-Request-Id",
        description: `Unique per request, 1-${MAX_REQUEST_ID_LENGTH} printable characters.`,
      },
      MmatfSignature: {
        type: "apiKey",
        in: "header",
        name: "X-MMATF-Signature",
        description:
          'sha256=<hex HMAC-SHA256 of "<timestamp>.<request_id>.<raw body>" keyed with your secret>.',
      },
    },
    schemas: {
      EventFields: { type: "object", additionalProperties: false, properties: fieldProps },
      EventUpsert: {
        type: "object",
        additionalProperties: false,
        required: ["external_id", ...TEMPLATE_COLUMNS.filter((c) => c.required).map((c) => c.key)],
        properties: { external_id: externalIdParam.schema, ...fieldProps },
      },
      WriteResult: {
        type: "object",
        required: ["external_id", "event_id", "outcome", "status"],
        properties: {
          external_id: { type: "string" },
          event_id: { type: "string" },
          outcome: {
            type: "string",
            enum: ["created", "update_staged", "unchanged", "cancel_staged"],
          },
          status: { type: "string", description: "The event's current listing status." },
          changes: {
            type: "object",
            description: "For update_staged: field → {current, proposed}.",
          },
          not_compared: {
            type: "array",
            items: { type: "string" },
            description: "Supplied fields the review does not compare on an existing event.",
          },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
      RefPage: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                external_id: { type: "string" },
                event_id: { type: ["string", "null"] },
                status: { type: ["string", "null"] },
                name: { type: ["string", "null"] },
                start_date: { type: ["string", "null"] },
                updated_at: { type: ["string", "null"] },
              },
            },
          },
          next_cursor: { type: ["string", "null"] },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field: { type: ["string", "null"] },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
