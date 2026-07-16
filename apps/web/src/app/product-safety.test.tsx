import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalActions } from "../components/review/approval-actions";
import { createGetHandler as createSyncGetHandler } from "./api/v1/miaoshou-syncs/route";
import { buildRerunInvalidation } from "./api/v1/products/[productId]/rerun/route";

describe("product safety boundary", () => {
  it("renders only draft, rerun and Miaoshou-edit confirmation actions", () => {
    const html = renderToStaticMarkup(<ApprovalActions
      productId="product-safe"
      revisionId="revision-safe"
      draftVersion={1}
      listingRunId="listing-safe"
      pricingRunId="pricing-safe"
      templateVersion={1}
      orderedFinalAssetIds={["asset-safe"]}
      targetLocale="th-TH"
      translationStyle="marketplace"
    />);
    const labels = Array.from(html.matchAll(/<button[^>]*>(.*?)<\/button>/g), (match) => match[1]);
    expect(labels).toEqual(expect.arrayContaining(["保存草稿设置", "开始局部重跑", "确认并推送妙手"]));
    expect(labels.some((label) => /claim|publish|TikTok/i.test(label))).toBe(false);
  });

  it("keeps mutation routes on an explicit product-safe allowlist", () => {
    const apiRoot = fileURLToPath(new URL("./api/v1", import.meta.url));
    const routeFiles = walk(apiRoot).filter((file) => file.endsWith("route.ts"));
    const mutationRoutes = routeFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return Array.from(source.matchAll(/export async function (POST|PATCH|PUT|DELETE)/g), (match) =>
        `${match[1]} ${relative(apiRoot, file).replaceAll("\\", "/").replace(/\/route\.ts$/, "")}`);
    }).sort();
    expect(mutationRoutes).toEqual([
      "PATCH products/[productId]/draft",
      "POST automation-runs",
      "POST ingest-links",
      "POST products/[productId]/confirm-miaoshou-edit",
      "POST products/[productId]/rerun",
      "POST tasks/[taskId]/actions"
    ]);

    const mutationSource = routeFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(mutationSource).not.toMatch(/from\s+["']@tk\/adapters/);
    expect(mutationSource).not.toMatch(/\.(?:claim|publish|editTikTokCollectBox)\s*\(/);
  });

  it("keeps Miaoshou sync status strictly read-only", async () => {
    const response = await createSyncGetHandler({
      syncs: { list: async () => ({ items: [] }) }
    })(new Request("http://127.0.0.1/api/v1/miaoshou-syncs"));
    expect(response.status).toBe(200);

    const source = readFileSync(new URL("./api/v1/miaoshou-syncs/route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/export async function (POST|PATCH|PUT|DELETE)/);
  });

  it("logically invalidates only downstream projections while preserving run history", () => {
    expect(buildRerunInvalidation("canvas")).toEqual({
      invalidatedNodes: ["canvas", "approval"],
      preservedNodes: ["collection", "asset_archive", "listing", "pricing", "template"]
    });
    expect(buildRerunInvalidation("pricing").preservedNodes).toContain("listing");

    const source = readFileSync(new URL("./api/v1/products/[productId]/rerun/route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DELETE\s+FROM\s+(listing_drafts|pricing_runs|canvas_runs)/i);
    expect(source).toMatch(/INSERT INTO product_revisions/);
    expect(source).toMatch(/INSERT INTO listing_drafts/);
    expect(source).toMatch(/INSERT INTO pricing_runs/);
    expect(source).toMatch(/approvalInvalidation\.invalidateInTransaction/);
    expect(source).not.toMatch(/UPDATE approval_snapshots SET state = 'invalidated'/);

    const draftSource = readFileSync(new URL("./api/v1/products/[productId]/draft/route.ts", import.meta.url), "utf8");
    expect(draftSource).toMatch(/INSERT INTO product_revisions/);
    expect(draftSource).toMatch(/approvalInvalidation\.invalidateInTransaction/);
    expect(draftSource).not.toMatch(/UPDATE approval_snapshots SET state = 'invalidated'/);
    expect(draftSource).toMatch(/SELECT id FROM products WHERE id = \$1 FOR UPDATE/);
    expect(draftSource).toMatch(/actualDraftVersion !== command\.expectedDraftVersion/);

    const invalidationSource = readFileSync(new URL("../server/services/approval-invalidation.ts", import.meta.url), "utf8");
    expect(invalidationSource).toMatch(/repository\.invalidateForProductInTransaction/);
    expect(invalidationSource).not.toMatch(/SELECT id FROM approval_snapshots/);

    const coreSource = readFileSync(
      new URL("../../../../packages/db/src/repositories/approval-repository.ts", import.meta.url),
      "utf8"
    );
    const productLock = coreSource.indexOf("SELECT id FROM ${schema.products}");
    const approvalLock = coreSource.indexOf("SELECT id FROM ${schema.approvalSnapshots}");
    const syncLock = coreSource.indexOf("SELECT state FROM ${schema.miaoshouSyncs}");
    const jobLock = coreSource.indexOf("SELECT status FROM ${schema.jobs}");
    expect(productLock).toBeGreaterThan(-1);
    expect(productLock).toBeLessThan(approvalLock);
    expect(approvalLock).toBeLessThan(syncLock);
    expect(syncLock).toBeLessThan(jobLock);
    expect(coreSource).toMatch(/syncState === "syncing" \|\| syncState === "result_unknown"/);
    expect(coreSource).toMatch(/status IN \('queued', 'paused'\)/);
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}
