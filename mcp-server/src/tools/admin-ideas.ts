/**
 * OPE-1178 — the idea log: `add_idea`, `list_ideas`, `update_idea`.
 *
 * Product ideas (features, improvements) live in their own table, apart from
 * every defect ledger, so an idea never inflates a defect count, never trips a
 * silence alarm, and is never "resolved" by a fault workflow. The first one came
 * from a customer asking how to pay his wife's booth fee as a gift — a feature
 * nobody had thought of, with nowhere to put it.
 *
 * Cross-reading is allowed (John, 2026-09-27): `related_refs` points at
 * fault-side rows as `<kind>:<id>`. What stays separate is counting.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import {
  containsCI,
  IDEA_PRODUCTS,
  IDEA_REF_KINDS,
  IDEA_SOURCE_TYPES,
  IDEA_STATUSES,
} from "@takemetothefair/db-schema";
import { productIdeas } from "../schema.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const REF_PATTERN = new RegExp(`^(${IDEA_REF_KINDS.join("|")}):\\S{1,200}$`);

/** A related ref is `<kind>:<id>` with a known kind. */
export function isValidRelatedRef(ref: string): boolean {
  return REF_PATTERN.test(ref);
}

/** `source_person` is a name. An address is refused, not silently stripped. */
export function looksLikeEmail(value: string | null | undefined): boolean {
  return typeof value === "string" && value.includes("@");
}

function parseList(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Order-preserving union — a ref recorded twice is recorded once. */
function union(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

function present(row: typeof productIdeas.$inferSelect) {
  return {
    ...row,
    relatedRefs: parseList(row.relatedRefs),
    extraSourceRefs: parseList(row.extraSourceRefs),
  };
}

const freeText = (max: number) => z.string().min(1).max(max).transform(decodeHtmlEntities);
const relatedRefsSchema = z
  .array(z.string().min(3).max(260))
  .max(50)
  .describe(
    `Links to fault-side rows or other ideas, each "<kind>:<id>". Kinds: ${IDEA_REF_KINDS.join(", ")}.`
  );

export interface AddIdeaInput {
  title: string;
  description?: string;
  product?: (typeof IDEA_PRODUCTS)[number];
  area?: string;
  sourceType?: (typeof IDEA_SOURCE_TYPES)[number];
  sourceRef?: string;
  sourcePerson?: string;
  status?: (typeof IDEA_STATUSES)[number];
  relatedRefs?: string[];
  notes?: string;
  createdBy?: string | null;
  now?: Date;
}

export async function addIdea(db: Db, input: AddIdeaInput) {
  if (looksLikeEmail(input.sourcePerson)) {
    throw new Error("source_person must be a name, not an email address");
  }
  const bad = (input.relatedRefs ?? []).filter((r) => !isValidRelatedRef(r));
  if (bad.length) throw new Error(`invalid related_refs: ${bad.join(", ")}`);
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(productIdeas)
    .values({
      id: crypto.randomUUID(),
      title: input.title,
      description: input.description ?? null,
      product: input.product ?? "mmatf",
      area: input.area ?? null,
      sourceType: input.sourceType ?? "other",
      sourceRef: input.sourceRef ?? null,
      sourcePerson: input.sourcePerson ?? null,
      status: input.status ?? "new",
      relatedRefs: JSON.stringify(union([], input.relatedRefs ?? [])),
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return present(row);
}

export interface UpdateIdeaInput {
  id: string;
  status?: (typeof IDEA_STATUSES)[number];
  notes?: string;
  linkedIssue?: string | null;
  /** Record that the idea came up again: votes + 1, optional extra source. */
  bumpVote?: boolean;
  extraSourceRef?: string;
  /** Appended (union), never replaced — a link someone recorded is kept. */
  addRelatedRefs?: string[];
  now?: Date;
}

export async function updateIdea(db: Db, input: UpdateIdeaInput) {
  const [current] = await db.select().from(productIdeas).where(eq(productIdeas.id, input.id));
  if (!current) return null;
  const bad = (input.addRelatedRefs ?? []).filter((r) => !isValidRelatedRef(r));
  if (bad.length) throw new Error(`invalid related_refs: ${bad.join(", ")}`);

  const set: Partial<typeof productIdeas.$inferInsert> = { updatedAt: input.now ?? new Date() };
  if (input.status) set.status = input.status;
  if (input.notes !== undefined) set.notes = input.notes;
  if (input.linkedIssue !== undefined) set.linkedIssue = input.linkedIssue;
  if (input.bumpVote) set.votes = current.votes + 1;
  if (input.extraSourceRef) {
    set.extraSourceRefs = JSON.stringify(
      union(parseList(current.extraSourceRefs), [input.extraSourceRef])
    );
  }
  if (input.addRelatedRefs?.length) {
    set.relatedRefs = JSON.stringify(union(parseList(current.relatedRefs), input.addRelatedRefs));
  }
  const [row] = await db
    .update(productIdeas)
    .set(set)
    .where(eq(productIdeas.id, input.id))
    .returning();
  return present(row);
}

export interface ListIdeasInput {
  status?: (typeof IDEA_STATUSES)[number];
  product?: (typeof IDEA_PRODUCTS)[number];
  area?: string;
  sourceType?: (typeof IDEA_SOURCE_TYPES)[number];
  query?: string;
  relatedRef?: string;
  limit?: number;
}

export async function listIdeas(db: Db, input: ListIdeasInput) {
  const where: SQL[] = [];
  if (input.status) where.push(eq(productIdeas.status, input.status));
  if (input.product) where.push(eq(productIdeas.product, input.product));
  if (input.sourceType) where.push(eq(productIdeas.sourceType, input.sourceType));
  // containsCI, never a LIKE built from input: D1 caps a LIKE pattern at 50 bytes.
  if (input.area) where.push(containsCI(productIdeas.area, input.area));
  if (input.query) {
    where.push(
      or(
        containsCI(productIdeas.title, input.query),
        containsCI(productIdeas.description, input.query),
        containsCI(productIdeas.notes, input.query)
      )!
    );
  }
  if (input.relatedRef) {
    where.push(
      sql`EXISTS (SELECT 1 FROM json_each(${productIdeas.relatedRefs}) WHERE json_each.value = ${input.relatedRef})`
    );
  }
  const rows = await db
    .select()
    .from(productIdeas)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(productIdeas.votes), desc(productIdeas.createdAt))
    .limit(input.limit ?? 50);
  return rows.map(present);
}

export function registerIdeaTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "add_idea",
    [
      "OPE-1178 — record a product IDEA (a feature or improvement worth remembering,",
      "not yet decided). NOT for bugs: defects go to problem reports / discrepancies /",
      "the fault ledger, which have counts and alarms; ideas deliberately do not.",
      "`source_person` is a NAME only — an email address is refused.",
      "`related_refs` links fault-side rows as `<kind>:<id>`.",
      "If the idea already exists, call update_idea with bump_vote instead. Admin only.",
    ].join(" "),
    {
      title: freeText(200),
      description: freeText(4000).optional(),
      product: z.enum(IDEA_PRODUCTS).optional(),
      area: freeText(100).optional(),
      source_type: z.enum(IDEA_SOURCE_TYPES).optional(),
      source_ref: z.string().min(1).max(500).optional(),
      source_person: freeText(120).optional(),
      status: z.enum(IDEA_STATUSES).optional(),
      related_refs: relatedRefsSchema.optional(),
      notes: freeText(4000).optional(),
    },
    async (a) => {
      try {
        const idea = await addIdea(db, {
          title: a.title,
          description: a.description,
          product: a.product,
          area: a.area,
          sourceType: a.source_type,
          sourceRef: a.source_ref,
          sourcePerson: a.source_person,
          status: a.status,
          relatedRefs: a.related_refs,
          notes: a.notes,
          createdBy: auth.userId ?? null,
        });
        return { content: [jsonContent({ created: true, idea })] };
      } catch (e) {
        return {
          content: [jsonContent({ error: e instanceof Error ? e.message : String(e) })],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_ideas",
    [
      "OPE-1178 — list product ideas, most-requested first. Filters: status, product,",
      "area (substring), source_type, query (substring of title/description/notes),",
      "related_ref (exact `<kind>:<id>`). Read-only. Admin only.",
    ].join(" "),
    {
      status: z.enum(IDEA_STATUSES).optional(),
      product: z.enum(IDEA_PRODUCTS).optional(),
      area: z.string().min(1).max(100).optional(),
      source_type: z.enum(IDEA_SOURCE_TYPES).optional(),
      query: z.string().min(2).max(200).optional(),
      related_ref: z.string().min(3).max(260).optional(),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async (a) => {
      const ideas = await listIdeas(db, {
        status: a.status,
        product: a.product,
        area: a.area,
        sourceType: a.source_type,
        query: a.query,
        relatedRef: a.related_ref,
        limit: a.limit,
      });
      return { content: [jsonContent({ count: ideas.length, ideas })] };
    }
  );

  server.tool(
    "update_idea",
    [
      "OPE-1178 — change an idea's status, notes or linked_issue (the OPE it became);",
      "`bump_vote: true` records that it came up again (votes + 1, with an optional",
      "`extra_source_ref`); `add_related_refs` appends links, never replaces them.",
      "Admin only.",
    ].join(" "),
    {
      id: z.string().min(1).max(64),
      status: z.enum(IDEA_STATUSES).optional(),
      notes: freeText(4000).optional(),
      linked_issue: z.string().min(1).max(64).nullable().optional(),
      bump_vote: z.boolean().optional(),
      extra_source_ref: z.string().min(1).max(500).optional(),
      add_related_refs: relatedRefsSchema.optional(),
    },
    async (a) => {
      try {
        const idea = await updateIdea(db, {
          id: a.id,
          status: a.status,
          notes: a.notes,
          linkedIssue: a.linked_issue,
          bumpVote: a.bump_vote,
          extraSourceRef: a.extra_source_ref,
          addRelatedRefs: a.add_related_refs,
        });
        if (!idea) {
          return { content: [jsonContent({ error: `no idea with id ${a.id}` })], isError: true };
        }
        return { content: [jsonContent({ updated: true, idea })] };
      } catch (e) {
        return {
          content: [jsonContent({ error: e instanceof Error ? e.message : String(e) })],
          isError: true,
        };
      }
    }
  );
}
