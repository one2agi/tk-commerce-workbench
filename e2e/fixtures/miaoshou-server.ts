import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const SOURCE_ITEM_ID = "892408514788";
const CANONICAL_DETAIL_ID = "3799770548";
const DUPLICATE_DETAIL_ID = "3799770999";

type RecordedCall = {
  path: string;
  body: Record<string, unknown>;
};

export interface PublishedEditCall {
  readonly path: string;
  readonly canonicalSuccessDetailId: string;
  readonly sourceItemId: string;
  readonly orderedRemoteAssetUrls: readonly string[];
  readonly idempotencyKey: string;
  readonly receivedAt: number;
}

export interface MockMiaoshouServer {
  readonly baseUrl: string;
  readonly calls: readonly RecordedCall[];
  /** Edit calls recorded via the new published-URL-only contract. */
  readonly publishedEditCalls: readonly PublishedEditCall[];
  /** Accept published URLs only (reject any Canvas URL). Defaults to true. */
  setPublishedUrlsOnly(strict: boolean): void;
  count(pathSuffix: string): number;
  countPublishedEdits(): number;
  close(): Promise<void>;
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function detailEnvelope() {
  return {
    result: "success",
    code: "0",
    data: {
      editCommonCollectBoxDetail: {
        commonCollectBoxDetailId: CANONICAL_DETAIL_ID,
        title: "轻薄防晒男士夹克",
        notesText: "透气面料，适合东南亚日常穿着",
        price: "35.80",
        stock: 125,
        weight: "0.45",
        packageLength: "30",
        packageWidth: "24",
        packageHeight: "4",
        cateList: ["男装", "夹克"],
        imgUrls: ["https://fixtures.invalid/product-main.jpg"],
        sourceAttrs: [{ name: "面料", value: "聚酯纤维" }],
        colorPropName: "颜色",
        colorMap: { 黑色: {}, 灰色: {} },
        sizePropName: "尺码",
        sizeMap: { M: {}, L: {} },
        skuMap: {
          "黑色;M": { itemNum: "sku-black-m", price: "35.80", stock: 60 },
          "灰色;L": { itemNum: "sku-gray-l", price: "36.80", stock: 65 }
        },
        sourceList: [{
          source: "1688",
          sourceItemId: SOURCE_ITEM_ID,
          sourceItemUrl: `https://detail.1688.com/offer/${SOURCE_ITEM_ID}.html`
        }]
      }
    }
  };
}

/**
 * Best-effort Canvas URL detector. The brief explicitly forbids Canvas URLs
 * in the new S3 AssetPublishingPort path; if any of the image urls look like
 * the legacy Canvas CDN we surface a structured failure so tests can assert
 * the published-URL-only contract.
 */
function looksLikeCanvasUrl(url: string): boolean {
  return /canvas|edge\.runware|edgeone|tencent\.canvas|canvas-internal/i.test(url);
}

export async function startMockMiaoshouServer(): Promise<MockMiaoshouServer> {
  const calls: RecordedCall[] = [];
  const publishedEditCalls: PublishedEditCall[] = [];
  let fetchCount = 0;
  let strictPublishedOnly = true;

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url) {
        json(response, { error: "not_found" }, 404);
        return;
      }
      if (!request.headers["x-app-key"] || !request.headers["x-sign"] || !request.headers["x-timestamp"]) {
        json(response, { result: "fail", code: "signMissing" }, 401);
        return;
      }
      const body = await readJson(request);
      calls.push({ path: request.url, body });

      if (request.url.endsWith("/fetch_item")) {
        fetchCount += 1;
        json(response, {
          result: "success",
          code: "0",
          data: {
            sourceItemIdAndDetailIdMap: {
              [SOURCE_ITEM_ID]: fetchCount === 1 ? CANONICAL_DETAIL_ID : DUPLICATE_DETAIL_ID
            }
          }
        });
        return;
      }
      if (request.url.endsWith("/get_common_collect_box_list")) {
        json(response, {
          result: "success",
          code: "0",
          data: {
            total: 1,
            hasNext: false,
            detailList: [{
              commonCollectBoxDetailId: CANONICAL_DETAIL_ID,
              status: "collectSuccess",
              gmtModified: "2026-07-16T00:00:00Z",
              sourceList: [{ source: "1688", sourceItemId: SOURCE_ITEM_ID }]
            }]
          }
        });
        return;
      }
      if (request.url.endsWith("/get_common_collect_box_detail")) {
        json(response, detailEnvelope());
        return;
      }
      if (request.url.endsWith("/edit_common_collect_box_detail")) {
        const requestedDetailId = String(
          body.commonCollectBoxDetailId ?? body.detailId ?? ""
        );
        if (requestedDetailId !== CANONICAL_DETAIL_ID) {
          json(response, { result: "fail", code: "detailNotFound" }, 404);
          return;
        }
        json(response, {
          result: "success",
          code: "0",
          data: { commonCollectBoxDetailId: CANONICAL_DETAIL_ID }
        });
        return;
      }
      // -----------------------------------------------------------------
      // New: headless image-generation writeback via S3 published URLs.
      //
      // The new miaoshou_edit writeback path uses the AssetPublishingPort
      // (S3 / CDN) to publish approved local assets first, then passes the
      // *remote URLs* (NOT Canvas URLs) to this endpoint. This route is
      // additive — the legacy edit_common_collect_box_detail route is kept
      // for the legacy Canvas-era flow.
      //
      // Body shape:
      //   {
      //     canonicalSuccessDetailId: string,
      //     sourceItemId: string,
      //     orderedRemoteAssetUrls: string[],   // S3 / CDN URLs only
      //     idempotencyKey: string
      //   }
      // -----------------------------------------------------------------
      if (request.url.endsWith("/edit_published_assets")) {
        const canonicalSuccessDetailId = String(body.canonicalSuccessDetailId ?? "");
        const sourceItemId = String(body.sourceItemId ?? "");
        const orderedRemoteAssetUrls = Array.isArray(body.orderedRemoteAssetUrls)
          ? (body.orderedRemoteAssetUrls as unknown[]).map(String)
          : [];
        const idempotencyKey = String(body.idempotencyKey ?? "");

        if (canonicalSuccessDetailId !== CANONICAL_DETAIL_ID) {
          json(response, {
            result: "fail",
            code: "detailNotFound",
            message: `expected ${CANONICAL_DETAIL_ID}, got ${canonicalSuccessDetailId}`
          }, 404);
          return;
        }
        if (orderedRemoteAssetUrls.length === 0) {
          json(response, {
            result: "fail",
            code: "emptyImageList",
            message: "orderedRemoteAssetUrls must contain at least one URL"
          }, 400);
          return;
        }
        if (strictPublishedOnly && orderedRemoteAssetUrls.some(looksLikeCanvasUrl)) {
          json(response, {
            result: "fail",
            code: "canvasUrlRejected",
            message: "published-URL-only contract: Canvas URLs are not accepted"
          }, 422);
          return;
        }

        publishedEditCalls.push({
          path: request.url,
          canonicalSuccessDetailId,
          sourceItemId,
          orderedRemoteAssetUrls,
          idempotencyKey,
          receivedAt: Date.now()
        });

        json(response, {
          result: "success",
          code: "0",
          data: {
            commonCollectBoxDetailId: canonicalSuccessDetailId,
            appliedImageCount: orderedRemoteAssetUrls.length
          }
        });
        return;
      }
      json(response, { error: "not_found" }, 404);
    } catch {
      json(response, { error: "invalid_request" }, 400);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock Miaoshou did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    publishedEditCalls,
    setPublishedUrlsOnly(strict: boolean) {
      strictPublishedOnly = Boolean(strict);
    },
    count: (pathSuffix) => calls.filter((call) => call.path.endsWith(pathSuffix)).length,
    countPublishedEdits: () => publishedEditCalls.length,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}