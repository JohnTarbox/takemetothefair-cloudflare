/**
 * OPE-1209 — a vendor issue's page is the target of that issue's "view in
 * browser" link, so it is where a forwarded vendor digest lands. It rendered the
 * ATTENDEE signup block; it must offer the vendor list, and an attendee issue
 * must still offer the attendee list (both directions, same fixture).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

let issueRow: Record<string, unknown> | null = null;

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (issueRow ? [issueRow] : []) }) }),
    }),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
function BlockStub(_: { source: string; audience?: string }) {
  return null;
}
vi.mock("@/components/newsletter/newsletter-signup-block", () => ({
  NewsletterSignupBlock: BlockStub,
}));

const Page = (await import("../page")).default as (p: {
  params: Promise<{ slug: string }>;
}) => Promise<ReactElement>;

/** Depth-first search of the returned element tree for the signup block. */
function findBlock(node: ReactNode): { source: string; audience?: string } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findBlock(n);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === BlockStub) return el.props as unknown as { source: string; audience?: string };
  return findBlock(el.props?.children);
}

const SENT = {
  slug: "issue-1",
  subject: "s",
  html: "<p>hi</p>",
  sentAt: new Date("2026-09-28T00:00:00Z"),
};

beforeEach(() => {
  issueRow = null;
});

describe("the per-issue page's signup block follows the issue's audience", () => {
  it("a VENDOR issue offers the vendor list", async () => {
    issueRow = { ...SENT, audience: "vendor" };
    const block = findBlock(await Page({ params: Promise.resolve({ slug: "issue-1" }) }));
    expect(block).not.toBeNull();
    expect(block!.audience).toBe("vendor");
  });

  it("a WEEKEND issue still offers the weekend list", async () => {
    issueRow = { ...SENT, audience: "weekend" };
    const block = findBlock(await Page({ params: Promise.resolve({ slug: "issue-1" }) }));
    expect(block!.audience).toBe("weekend");
  });
});
