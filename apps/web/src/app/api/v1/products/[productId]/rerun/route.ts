import { randomUUID } from "node:crypto";
import pg from "pg";
import { RerunDownstreamV1, type RerunDownstreamV1 as RerunCommand } from "@tk/contracts";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import { loadRuntimeConfig } from "../../../../../../server/composition";
import {
  createPgApprovalInvalidationPort,
  type ApprovalInvalidationPort
} from "../../../../../../server/services/approval-invalidation";

type Context = { params: Promise<{ productId: string }> };
type RerunResult = { accepted: true; jobId?: string; revisionId?: string; draftVersion?: number; approvalInvalidated?: true; invalidatedNodes: string[] };
export interface RerunPort { enqueue(command: RerunCommand, productId: string): Promise<RerunResult> }

export function createPostHandler(dependencies: { reruns: RerunPort }) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request) ?? rejectUnsafeBrowserMutation(request);
    if (rejected) return rejected;
    const { productId } = await context.params;
    const parsed = RerunDownstreamV1.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      return Response.json(await dependencies.reruns.enqueue(parsed.data, productId), { status: 202 });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "approval_sync_in_progress" || code === "stale_draft_version") {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: "rerun_failed" }, { status: 500 });
    }
  };
}

let pool: pg.Pool | undefined;
function database(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: loadRuntimeConfig().databaseUrl });
  return pool;
}

export type RerunInvalidation = Readonly<{ invalidatedNodes: string[]; preservedNodes: string[] }>;
const downstream: Record<RerunCommand["startNode"], RerunInvalidation> = {
  listing: { invalidatedNodes: ["listing", "pricing", "template", "canvas", "approval"], preservedNodes: ["collection", "asset_archive"] },
  pricing: { invalidatedNodes: ["pricing", "template", "canvas", "approval"], preservedNodes: ["collection", "asset_archive", "listing"] },
  template: { invalidatedNodes: ["template", "canvas", "approval"], preservedNodes: ["collection", "asset_archive", "listing", "pricing"] },
  canvas: { invalidatedNodes: ["canvas", "approval"], preservedNodes: ["collection", "asset_archive", "listing", "pricing", "template"] }
};
export function buildRerunInvalidation(startNode: RerunCommand["startNode"]): RerunInvalidation {
  return downstream[startNode];
}
const firstJob: Record<RerunCommand["startNode"], string> = {
  listing: "listing_generate", pricing: "pricing_calculate", template: "template_match", canvas: "canvas_generate"
};

export function createPgRerunPort(approvalInvalidation: ApprovalInvalidationPort): RerunPort {
  return {
  async enqueue(command, productId) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const product = await client.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [productId]);
      if (product.rowCount !== 1) throw Object.assign(new Error("product_not_found"), { code: "product_not_found" });
      const locked = await client.query<{
        draft_version: number; source_title: string | null; source_payload: Record<string, unknown>;
        working_draft: Record<string, unknown>;
      }>(
        `SELECT draft_version, source_title, source_payload, working_draft
         FROM product_revisions WHERE id = $1 AND product_id = $2
           AND draft_version = (SELECT max(draft_version) FROM product_revisions WHERE product_id = $2)
         FOR UPDATE`,
        [command.revisionId, productId]
      );
      const previous = locked.rows[0];
      if (Number(previous?.draft_version) !== command.expectedDraftVersion) {
        throw Object.assign(new Error("stale_draft_version"), { code: "stale_draft_version" });
      }
      await approvalInvalidation.invalidateInTransaction(client, productId, "downstream_rerun_requested");
      const invalidation = buildRerunInvalidation(command.startNode);
      const newRevisionId = `revision_${randomUUID()}`;
      const newDraftVersion = command.expectedDraftVersion + 1;
      const oldDraft = previous.working_draft ?? {};
      const oldAssets = await client.query<Record<string, unknown>>(
        `SELECT * FROM assets WHERE revision_id = $1 AND kind <> 'generated' ORDER BY created_at, id`,
        [command.revisionId]
      );
      const assetIds = new Map<string, string>();
      for (const asset of oldAssets.rows) assetIds.set(String(asset.id), `asset_${randomUUID()}`);
      const nextDraft: Record<string, unknown> = { ...oldDraft };
      delete nextDraft.finalAssetOrder;
      delete nextDraft.approvalPreview;
      if (["listing", "pricing", "template"].includes(command.startNode)) {
        delete nextDraft.templateMatch;
        delete nextDraft.imageSelection;
      } else if (nextDraft.imageSelection && typeof nextDraft.imageSelection === "object") {
        const selection = nextDraft.imageSelection as Record<string, unknown>;
        nextDraft.imageSelection = {
          ...selection,
          assetIds: Array.isArray(selection.assetIds)
            ? selection.assetIds.map(String).map((id) => assetIds.get(id)).filter((id): id is string => Boolean(id))
            : []
        };
      }
      nextDraft.downstreamInvalidation = {
        startNode: command.startNode,
        expectedDraftVersion: command.expectedDraftVersion,
        invalidatedNodes: invalidation.invalidatedNodes,
        preservedNodes: invalidation.preservedNodes,
        invalidatedAt: new Date().toISOString()
      };
      await client.query(
        `INSERT INTO product_revisions
         (id, product_id, draft_version, source_title, source_payload, working_draft)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [newRevisionId, productId, newDraftVersion, previous.source_title,
          JSON.stringify(previous.source_payload ?? {}), JSON.stringify(nextDraft)]
      );
      if (command.startNode !== "listing") {
        const listing = await client.query(
          `INSERT INTO listing_drafts
           (id, product_id, revision_id, draft_version, target_locale, style, title, description,
            attributes, provider, model, fallback_used)
           SELECT $1, product_id, $2, $3, target_locale, style, title, description,
                  attributes, provider, model, fallback_used
           FROM listing_drafts WHERE revision_id = $4
           ORDER BY created_at DESC LIMIT 1`,
          [`listing_${randomUUID()}`, newRevisionId, newDraftVersion, command.revisionId]
        );
        if (listing.rowCount !== 1) throw Object.assign(new Error("listing_prerequisite_missing"), { code: "listing_prerequisite_missing" });
      }
      if (["template", "canvas"].includes(command.startNode)) {
        const pricing = await client.query(
          `INSERT INTO pricing_runs
           (id, product_id, revision_id, draft_version, state, breakdown, final_price_minor,
            final_currency, ending, exchange_rate_snapshot_id)
           SELECT $1, product_id, $2, $3, state, breakdown, final_price_minor,
                  final_currency, ending, exchange_rate_snapshot_id
           FROM pricing_runs WHERE revision_id = $4
           ORDER BY created_at DESC LIMIT 1`,
          [`pricing_${randomUUID()}`, newRevisionId, newDraftVersion, command.revisionId]
        );
        if (pricing.rowCount !== 1) throw Object.assign(new Error("pricing_prerequisite_missing"), { code: "pricing_prerequisite_missing" });
      }
      for (const asset of oldAssets.rows) {
        await client.query(
          `INSERT INTO assets
           (id, product_id, revision_id, remote_url, kind, state, width, height, sha256, local_path,
            extension, perceptual_hash, clarity, duplicate_distance, watermark_probability,
            collage_probability, non_product_probability, visual_score, chosen_role, rejection_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [assetIds.get(String(asset.id)), productId, newRevisionId, asset.remote_url, asset.kind, asset.state,
            asset.width, asset.height, asset.sha256, asset.local_path, asset.extension, asset.perceptual_hash,
            asset.clarity, asset.duplicate_distance, asset.watermark_probability, asset.collage_probability,
            asset.non_product_probability, asset.visual_score, asset.chosen_role, asset.rejection_reason]
        );
      }
      const listingState = command.startNode === "listing" ? "pending" : null;
      await client.query(
        `UPDATE products SET state_listing = COALESCE($2, state_listing), state_canvas = 'not_started',
          state_approval = 'unapproved', state_miaoshou_edit = 'not_started', version = version + 1, updated_at = now()
         WHERE id = $1`, [productId, listingState]
      );
      const jobId = `job_${randomUUID()}`;
      const businessKey = `${newRevisionId}:rerun:${newDraftVersion}:${command.startNode}`;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO jobs (id, kind, business_key, idempotency_key, payload, status)
         VALUES ($1, $2, $3, $3, $4::jsonb, 'queued')
         ON CONFLICT (kind, business_key) DO UPDATE SET updated_at = jobs.updated_at
         RETURNING id`,
        [jobId, firstJob[command.startNode], businessKey, JSON.stringify({ version: 1, revisionId: newRevisionId })]
      );
      await client.query(
        `INSERT INTO audit_events (id, actor_type, action, target_kind, target_id, payload, redacted)
         VALUES ($1, 'operator', 'product_downstream_rerun', 'product_revision', $2, $3::jsonb, true)`,
        [`audit_${randomUUID()}`, newRevisionId, JSON.stringify({ previousRevisionId: command.revisionId,
          startNode: command.startNode, previousDraftVersion: command.expectedDraftVersion, draftVersion: newDraftVersion })]
      );
      await client.query("COMMIT");
      return { accepted: true as const, jobId: inserted.rows[0]?.id, revisionId: newRevisionId,
        draftVersion: newDraftVersion, approvalInvalidated: true as const, invalidatedNodes: invalidation.invalidatedNodes };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  };
}

const pgReruns = createPgRerunPort(
  createPgApprovalInvalidationPort(database)
);

export async function POST(request: Request, context: Context): Promise<Response> {
  return createPostHandler({ reruns: pgReruns })(request, context);
}
