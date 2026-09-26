export const dynamic = "force-dynamic";
/**
 * OPE-227 increment B — approve or reject a staged hero proposal.
 *
 * POST { proposal_id, decision: "approve" | "reject", note? }
 * Auth: admin session OR X-Internal-Key (the `resolve_hero_proposal` MCP tool).
 *
 * The only path by which the photo flywheel writes `events.image_url`, and only
 * into an empty slot — or (OPE-746) over the exact URL the rot sweep found
 * dead, after re-probing it. See `src/lib/photo-flywheel/hero-resolve.ts`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { runUploadPipeline } from "@/lib/upload-image-pipeline";
import { resolveHeroProposal } from "@/lib/photo-flywheel/hero-resolve";
import { probeImageUrl } from "@/lib/photo-coverage/rot";

const Body = z.object({
  proposal_id: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

export const POST = withAuthorized(async ({ request, db, userId }) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const env = getCloudflareEnv();
  const result = await resolveHeroProposal(
    db,
    {
      async readObject(key) {
        const obj = await env.VENDOR_ASSETS?.get(key);
        if (!obj) return null;
        return {
          bytes: new Uint8Array(await obj.arrayBuffer()),
          contentType: obj.httpMetadata?.contentType ?? "",
        };
      },
      runPipeline: (args) =>
        runUploadPipeline({ ...args, db, env: { VENDOR_ASSETS: env.VENDOR_ASSETS } }),
      probeUrl: async (url) => (await probeImageUrl(url)).ok,
      now: () => new Date(),
    },
    {
      proposalId: parsed.data.proposal_id,
      decision: parsed.data.decision,
      actorId: userId,
      note: parsed.data.note ?? null,
    }
  );
  return NextResponse.json(result.body, { status: result.status });
});
