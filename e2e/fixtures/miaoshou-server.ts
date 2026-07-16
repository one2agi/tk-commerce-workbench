import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const SOURCE_ITEM_ID = "892408514788";
const CANONICAL_DETAIL_ID = "3799770548";
const DUPLICATE_DETAIL_ID = "3799770999";

type RecordedCall = {
  path: string;
  body: Record<string, unknown>;
};

export interface MockMiaoshouServer {
  readonly baseUrl: string;
  readonly calls: readonly RecordedCall[];
  count(pathSuffix: string): number;
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
export async function startMockMiaoshouServer(): Promise<MockMiaoshouServer> {
  const calls: RecordedCall[] = [];
  let fetchCount = 0;
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
    count: (pathSuffix) => calls.filter((call) => call.path.endsWith(pathSuffix)).length,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
