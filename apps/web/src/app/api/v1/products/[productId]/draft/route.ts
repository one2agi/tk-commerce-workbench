import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { UpdateProductOverridesV1, type UpdateProductOverridesV1 as UpdateCommand } from "@tk/contracts";
import { ApprovalRepository } from "@tk/db";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import { loadRuntimeConfig } from "../../../../../../server/composition";
import { conflictResponse } from "../../../../../../server/http/safe-conflict";
import { BASIC_BCP47_PATTERN } from "../../../../../../lib/locale";
import {
  createApprovalInvalidationPort,
  type ApprovalInvalidationPort
} from "../../../../../../server/services/approval-invalidation";

type DraftUpdateRequest = UpdateCommand & Readonly<{ expectedDraftVersion: number }>;
const DraftUpdateRequest = UpdateProductOverridesV1.extend({
  expectedDraftVersion: z.number().int().positive(),
  targetLocale: z.string().regex(BASIC_BCP47_PATTERN).optional()
});

type Context = { params: Promise<{ productId: string }> };
export interface DraftPort {
  update(command: DraftUpdateRequest): Promise<{ draftVersion: number; revisionId?: string; approvalInvalidated: true }>;
}

export function createPatchHandler(dependencies: { drafts: DraftPort }) {
  return async function patch(request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request) ?? rejectUnsafeBrowserMutation(request);
    if (rejected) return rejected;
    const { productId } = await context.params;
    const parsed = DraftUpdateRequest.safeParse({ ...(await request.json().catch(() => null)), productId });
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      return Response.json(await dependencies.drafts.update(parsed.data));
    } catch (error) {
      const conflict = conflictResponse(error);
      if (conflict) return conflict;
      if ((error as { code?: string }).code === "approval_sync_in_progress") {
        return Response.json({ error: "approval_sync_in_progress" }, { status: 409 });
      }
      return Response.json({ error: "draft_update_failed" }, { status: 500 });
    }
  };
}

let pool: pg.Pool | undefined;
function database(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: loadRuntimeConfig().databaseUrl });
  return pool;
}

export function createPgDraftPort(approvalInvalidation: ApprovalInvalidationPort): DraftPort {
  return {
  async update(command) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const product = await client.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [command.productId]);
      if (product.rowCount !== 1) throw Object.assign(new Error("product_not_found"), { code: "product_not_found" });
      const versionResult = await client.query<{ draft_version: number }>(
        `SELECT max(draft_version)::integer AS draft_version FROM product_revisions WHERE product_id = $1`,
        [command.productId]
      );
      const actualDraftVersion = Number(versionResult.rows[0]?.draft_version ?? 0);
      if (actualDraftVersion !== command.expectedDraftVersion) {
        throw Object.assign(new Error("draft_version_conflict"), {
          code: "draft_version_conflict",
          field: "draftVersion",
          expected: String(command.expectedDraftVersion),
          actual: String(actualDraftVersion)
        });
      }
      const latest = await client.query<{
        id: string; draft_version: number; source_title: string | null;
        source_payload: Record<string, unknown>; working_draft: Record<string, unknown>;
      }>(`SELECT id, draft_version, source_title, source_payload, working_draft
          FROM product_revisions WHERE product_id = $1 AND draft_version = $2 FOR UPDATE`,
      [command.productId, command.expectedDraftVersion]);
      const row = latest.rows[0];
      if (!row) throw Object.assign(new Error("product_not_found"), { code: "product_not_found" });
      await approvalInvalidation.invalidateInTransaction(client, command.productId, "draft_overrides_updated");
      const nextVersion = row.draft_version + 1;
      const revisionId = `revision_${randomUUID()}`;
      const workingDraft: Record<string, unknown> = {
        ...(row.working_draft ?? {}),
        ...(command.targetLocale ? { targetLocale: command.targetLocale } : {}),
        ...(command.translationStyle ? { style: command.translationStyle } : {}),
        approvalInvalidatedAt: new Date().toISOString(),
        warningCodes: [],
        finalAssetOrder: []
      };
      delete workingDraft.templateMatch;
      delete workingDraft.imageSelection;
      delete workingDraft.approvalPreview;
      await client.query(
        `INSERT INTO product_revisions
         (id, product_id, draft_version, source_title, source_payload, working_draft)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [revisionId, command.productId, nextVersion, row.source_title, JSON.stringify(row.source_payload), JSON.stringify(workingDraft)]
      );
      await client.query(
        `INSERT INTO assets
         (id, product_id, revision_id, remote_url, kind, state, width, height, sha256, local_path,
          extension, perceptual_hash, clarity, duplicate_distance, watermark_probability,
          collage_probability, non_product_probability, visual_score, chosen_role, rejection_reason)
         SELECT 'asset_' || md5(id || $2), product_id, $2, remote_url, kind, state, width, height, sha256,
                local_path, extension, perceptual_hash, clarity, duplicate_distance, watermark_probability,
                collage_probability, non_product_probability, visual_score, chosen_role, rejection_reason
         FROM assets WHERE revision_id = $1 AND kind <> 'generated'`,
        [row.id, revisionId]
      );
      await client.query(
        `UPDATE products SET locale = COALESCE($2, locale), state_listing = 'pending',
           state_canvas = 'not_started', state_approval = 'unapproved', state_miaoshou_edit = 'not_started',
           version = version + 1, updated_at = now() WHERE id = $1`,
        [command.productId, command.targetLocale ?? null]
      );
      await client.query(
        `INSERT INTO audit_events (id, actor_type, action, target_kind, target_id, payload, redacted)
         VALUES ($1, 'operator', 'product_draft_overrides_updated', 'product', $2, $3::jsonb, true)`,
        [`audit_${randomUUID()}`, command.productId, JSON.stringify({ revisionId, draftVersion: nextVersion,
          changed: [command.targetLocale ? "targetLocale" : null, command.translationStyle ? "translationStyle" : null].filter(Boolean) })]
      );
      await client.query("COMMIT");
      return { draftVersion: nextVersion, revisionId, approvalInvalidated: true as const };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  };
}

const pgDrafts = createPgDraftPort(
  createApprovalInvalidationPort(new ApprovalRepository(database()))
);

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return createPatchHandler({ drafts: pgDrafts })(request, context);
}
