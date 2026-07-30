# Product List Image Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `/products/` 商品列表中，为每条商品记录直接展示全部采集原图和全部洗图结果，并提供分区内大图弹窗预览。

**Architecture:** 扩展 `ProductPoolItemV1` 和产品列表查询，让接口一次返回 `originalImageUrls` 与 `processedImageUrls`。原图优先使用本地归档资产，尚未归档的 1688/阿里图片通过严格域名白名单的同源读取接口展示；前端以独立 Gallery 组件渲染两个横向图片区，并以无路由跳转的预览弹窗放大当前分区图片。

**Tech Stack:** TypeScript 5.9、Next.js 16 App Router、React 19、PostgreSQL JSONB、Vitest、Testing Library、Playwright。

## Global Constraints

- 正式 UI 只修改现有 `http://127.0.0.1:3000/products/`，不新增独立业务页面。
- 每条商品记录直接显示 `原产品图` 与 `洗图后的图` 两个分区；查看原图不要求进入 `/products/<productId>`。
- 原图顺序为 `mainImages` 在前、`detailImages` 在后；相同 URL 仅出现一次。
- 图片较多时仅横向滚动，商品图片区域高度保持稳定。
- 点击缩略图只打开大图弹窗；弹窗不混合两个图片分区。
- 单图失败不得隐藏同分区其他图片。
- 外部原图读取只允许 HTTP(S) 的 `alicdn.com`、`1688.com` 及其子域名，禁止重定向并限制图片大小，防止 SSRF。
- 不改变采集流程、Canvas 生成逻辑、商品状态机、批量操作规则和详情页信息架构。
- 工作区已有大量未提交改动。每次提交前必须运行 `git diff --cached`；只提交本任务的新文件或可独立分离的新增代码，无法分离的既有修改保持未暂存并在交接中说明。

---

## File Structure

### Create

- `apps/web/src/server/source-image-url.ts`：验证 1688/阿里图片 URL，并生成同源读取地址。
- `apps/web/src/server/source-image-url.test.ts`：覆盖域名白名单、协议和编码行为。
- `apps/web/src/app/api/v1/source-images/route.ts`：安全获取尚未归档的源图片。
- `apps/web/src/app/api/v1/source-images/route.test.ts`：覆盖访问边界、重定向、内容类型和大小限制。
- `apps/web/src/components/products/image-preview-dialog.tsx`：当前图片分区的大图预览弹窗。
- `apps/web/src/components/products/product-image-gallery.tsx`：原图与洗图的横向分区展示。
- `apps/web/src/components/products/product-image-gallery.test.tsx`：覆盖直接展示、空状态、单图失败和弹窗交互。

### Modify

- `packages/contracts/src/read-models.ts`：给 `ProductPoolItemV1` 增加两个图片数组。
- `apps/web/src/server/services/product-service.ts`：投影有序原图、归档地址和 Canvas 输出。
- `apps/web/src/server/services/product-service.test.ts`：验证数据顺序、去重、归档优先和分区隔离。
- `apps/web/src/components/products/product-table.tsx`：在每条商品概要行后插入对应图片区。
- `apps/web/src/components/products/product-table.test.tsx`：验证图片归属于正确商品记录且无需详情跳转。
- `apps/web/src/app/globals.css`：实现横向图片带、失败状态和弹窗样式。
- `apps/web/src/app/products/page.test.tsx`
- `apps/web/src/app/final-review.test.tsx`
- `apps/web/src/components/products/product-row-view.test.ts`
- `apps/web/src/components/products/product-workbench.projection.test.ts`
- `apps/web/src/components/products/product-workbench.state.test.ts`
- `apps/web/src/lib/fixtures.ts`
  - 上述六个测试/fixture 文件补齐新的必填图片数组。
- `e2e/browser-workbench.spec.ts`：用数据库 fixture 验证 `/products/` 的真实分区和弹窗。

---

### Task 1: Secure Source Image Boundary

**Files:**
- Create: `apps/web/src/server/source-image-url.ts`
- Create: `apps/web/src/server/source-image-url.test.ts`
- Create: `apps/web/src/app/api/v1/source-images/route.ts`
- Create: `apps/web/src/app/api/v1/source-images/route.test.ts`

**Interfaces:**
- Produces: `parseAllowedSourceImageUrl(value: string): URL | null`
- Produces: `sourceImageProxyPath(value: string): string | null`
- Produces: `createGetHandler({ fetcher }): (request: Request) => Promise<Response>`
- Consumes: existing `rejectNonLoopback(request)` from `apps/web/src/server/auth/loopback.ts`

- [ ] **Step 1: Write URL-boundary failing tests**

Create `source-image-url.test.ts` with these assertions:

```ts
import { describe, expect, it } from "vitest";
import {
  parseAllowedSourceImageUrl,
  sourceImageProxyPath
} from "./source-image-url";

describe("source image URL boundary", () => {
  it.each([
    "https://cbu01.alicdn.com/img/ibank/a.jpg",
    "https://img.alicdn.com/imgextra/a.webp",
    "http://img.1688.com/a.png"
  ])("accepts configured source image hosts: %s", (value) => {
    expect(parseAllowedSourceImageUrl(value)?.href).toBe(value);
  });

  it.each([
    "https://alicdn.com.evil.test/a.jpg",
    "https://evilalicdn.com/a.jpg",
    "file:///etc/passwd",
    "http://127.0.0.1/private.png",
    "not-a-url"
  ])("rejects unsafe source image URLs: %s", (value) => {
    expect(parseAllowedSourceImageUrl(value)).toBeNull();
    expect(sourceImageProxyPath(value)).toBeNull();
  });

  it("encodes an allowed URL into the same-origin source image route", () => {
    const source = "https://cbu01.alicdn.com/img/a.jpg?x=1&y=2";
    expect(sourceImageProxyPath(source)).toBe(
      `/api/v1/source-images?url=${encodeURIComponent(source)}`
    );
  });
});
```

- [ ] **Step 2: Run the URL tests and verify RED**

Run:

```bash
pnpm --filter @tk/web exec vitest run src/server/source-image-url.test.ts
```

Expected: FAIL because `source-image-url.ts` does not exist.

- [ ] **Step 3: Implement the URL allowlist**

Create `source-image-url.ts`:

```ts
const ALLOWED_HOST_SUFFIXES = Object.freeze(["alicdn.com", "1688.com"]);

function matchesAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

export function parseAllowedSourceImageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return matchesAllowedHost(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function sourceImageProxyPath(value: string): string | null {
  const url = parseAllowedSourceImageUrl(value);
  return url ? `/api/v1/source-images?url=${encodeURIComponent(url.href)}` : null;
}
```

- [ ] **Step 4: Run the URL tests and verify GREEN**

Run:

```bash
pnpm --filter @tk/web exec vitest run src/server/source-image-url.test.ts
```

Expected: all URL-boundary tests PASS.

- [ ] **Step 5: Write source-image route failing tests**

Create `route.test.ts` with loopback requests and an injected fetcher:

```ts
import { describe, expect, it, vi } from "vitest";
import { createGetHandler, MAX_SOURCE_IMAGE_BYTES } from "./route";

const requestFor = (url: string) =>
  new Request(`http://127.0.0.1/api/v1/source-images?url=${encodeURIComponent(url)}`);

describe("GET /api/v1/source-images", () => {
  it("returns an allowed image with private caching and nosniff", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([137, 80, 78, 71]),
      { status: 200, headers: { "content-type": "image/png", "content-length": "4" } }
    ));
    const response = await createGetHandler({ fetcher })(
      requestFor("https://cbu01.alicdn.com/img/a.png")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    ["unsafe host", "https://example.com/a.jpg", 400],
    ["loopback target", "http://127.0.0.1/a.jpg", 400]
  ])("rejects %s", async (_name, url, status) => {
    const response = await createGetHandler({ fetcher: vi.fn() })(requestFor(url));
    expect(response.status).toBe(status);
  });

  it("rejects upstream redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/a" } })
    );
    const response = await createGetHandler({ fetcher })(
      requestFor("https://cbu01.alicdn.com/redirect")
    );
    expect(response.status).toBe(502);
  });

  it("rejects non-image and oversized responses", async () => {
    const nonImage = vi.fn().mockResolvedValue(
      new Response("html", { headers: { "content-type": "text/html" } })
    );
    expect((await createGetHandler({ fetcher: nonImage })(
      requestFor("https://cbu01.alicdn.com/a")
    )).status).toBe(415);

    const oversized = vi.fn().mockResolvedValue(new Response(
      new Uint8Array(1),
      { headers: {
        "content-type": "image/jpeg",
        "content-length": String(MAX_SOURCE_IMAGE_BYTES + 1)
      } }
    ));
    expect((await createGetHandler({ fetcher: oversized })(
      requestFor("https://cbu01.alicdn.com/a.jpg")
    )).status).toBe(413);
  });
});
```

- [ ] **Step 6: Run the route tests and verify RED**

Run:

```bash
pnpm --filter @tk/web exec vitest run src/app/api/v1/source-images/route.test.ts
```

Expected: FAIL because the route does not exist.

- [ ] **Step 7: Implement the guarded route**

Create `route.ts` with:

```ts
import { rejectNonLoopback } from "../../../../server/auth/loopback";
import { parseAllowedSourceImageUrl } from "../../../../server/source-image-url";

export const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024;

export function createGetHandler(dependencies: { fetcher?: typeof fetch }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;

    const raw = new URL(request.url).searchParams.get("url") ?? "";
    const sourceUrl = parseAllowedSourceImageUrl(raw);
    if (!sourceUrl) {
      return Response.json({ error: "invalid_source_image_url" }, { status: 400 });
    }

    try {
      const upstream = await (dependencies.fetcher ?? fetch)(sourceUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
          referer: "https://detail.1688.com/"
        }
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        return Response.json({ error: "source_image_redirect_rejected" }, { status: 502 });
      }
      if (!upstream.ok) {
        return Response.json({ error: "source_image_unavailable" }, { status: 502 });
      }
      const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!contentType.startsWith("image/")) {
        return Response.json({ error: "unsupported_source_image_type" }, { status: 415 });
      }
      const declaredSize = Number(upstream.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredSize) && declaredSize > MAX_SOURCE_IMAGE_BYTES) {
        return Response.json({ error: "source_image_too_large" }, { status: 413 });
      }
      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.byteLength > MAX_SOURCE_IMAGE_BYTES) {
        return Response.json({ error: "source_image_too_large" }, { status: 413 });
      }
      return new Response(body as BodyInit, {
        headers: {
          "content-type": contentType,
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff"
        }
      });
    } catch {
      return Response.json({ error: "source_image_unavailable" }, { status: 502 });
    }
  };
}

export const GET = createGetHandler({});
```

- [ ] **Step 8: Run all Task 1 tests**

Run:

```bash
pnpm --filter @tk/web exec vitest run \
  src/server/source-image-url.test.ts \
  src/app/api/v1/source-images/route.test.ts
```

Expected: both files PASS with zero unhandled errors.

- [ ] **Step 9: Commit Task 1 if the staged diff is isolated**

```bash
git add apps/web/src/server/source-image-url.ts \
  apps/web/src/server/source-image-url.test.ts \
  apps/web/src/app/api/v1/source-images/route.ts \
  apps/web/src/app/api/v1/source-images/route.test.ts
git diff --cached
git commit -m "feat(products): add secure source image reader"
```

---

### Task 2: Product List Image Projection

**Files:**
- Modify: `packages/contracts/src/read-models.ts:22-54`
- Modify: `apps/web/src/server/services/product-service.ts:22-190,295-336`
- Modify: `apps/web/src/server/services/product-service.test.ts`

**Interfaces:**
- Consumes: `sourceImageProxyPath(value: string): string | null`
- Produces: `ProductPoolItemV1.originalImageUrls: string[]`
- Produces: `ProductPoolItemV1.processedImageUrls: string[]`
- Produces: `/api/v1/products` items with both arrays

- [ ] **Step 1: Write the failing service projection test**

Extend `poolRow()` with:

```ts
source_main_images: [
  { url: "https://cbu01.alicdn.com/main-1.jpg" },
  "https://cbu01.alicdn.com/main-2.jpg"
],
source_detail_images: [
  { url: "https://cbu01.alicdn.com/main-1.jpg" },
  { url: "https://img.alicdn.com/detail-1.jpg" },
  { url: "https://example.com/rejected.jpg" }
],
archived_source_images: [{
  remoteUrl: "https://cbu01.alicdn.com/main-1.jpg",
  localUrl: "/api/v1/assets/asset-main-1/content"
}],
canvas_outputs: [
  "asset_canvas_1",
  "https://canvas.example/output-2.png",
  "invalid-output"
]
```

Add:

```ts
it("projects ordered original images separately from processed images", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [poolRow()] });
  const result = await new ProductService({ query }).list();

  expect(result.items[0]).toMatchObject({
    thumbnailUrl: "/api/v1/assets/asset-main-1/content",
    originalImageUrls: [
      "/api/v1/assets/asset-main-1/content",
      "/api/v1/source-images?url=https%3A%2F%2Fcbu01.alicdn.com%2Fmain-2.jpg",
      "/api/v1/source-images?url=https%3A%2F%2Fimg.alicdn.com%2Fdetail-1.jpg"
    ],
    processedImageUrls: [
      "/api/v1/assets/asset_canvas_1/content",
      "https://canvas.example/output-2.png"
    ]
  });

  const sql = query.mock.calls[0]?.[0] as string;
  expect(sql).toContain("archived_source_images");
  expect(sql).toContain("source_main_images");
  expect(sql).toContain("source_detail_images");
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
pnpm --filter @tk/web exec vitest run src/server/services/product-service.test.ts
```

Expected: FAIL because the list item has no `originalImageUrls` or `processedImageUrls`.

- [ ] **Step 3: Extend the read model**

Add after `thumbnailUrl` in `ProductPoolItemV1`:

```ts
/** Collected source images, main images first and detail images second. */
originalImageUrls: string[];
/** Valid outputs from the latest Canvas run; never includes source images. */
processedImageUrls: string[];
```

- [ ] **Step 4: Add source and archive fields to `PRODUCT_POOL_SQL`**

Select:

```sql
revision.source_payload->'mainImages' AS source_main_images,
revision.source_payload->'detailImages' AS source_detail_images,
COALESCE(archived_source_images.items, '[]'::jsonb) AS archived_source_images,
```

Add this lateral join before `asset_totals`:

```sql
LEFT JOIN LATERAL (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'remoteUrl', candidate.remote_url,
        'localUrl', '/api/v1/assets/' || candidate.id || '/content'
      )
      ORDER BY candidate.created_at ASC, candidate.id
    ),
    '[]'::jsonb
  ) AS items
  FROM assets candidate
  WHERE candidate.revision_id = revision.id
    AND candidate.state = 'ready'
    AND candidate.local_path IS NOT NULL
) archived_source_images ON true
```

- [ ] **Step 5: Implement deterministic image projection**

Import `sourceImageProxyPath` and add private helpers that:

```ts
type ArchivedSourceImage = Readonly<{ remoteUrl: string; localUrl: string }>;

function archivedSourceImageMap(value: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(value)) return new Map();
  const entries = value.flatMap((item): Array<[string, string]> => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return typeof row.remoteUrl === "string" && typeof row.localUrl === "string"
      ? [[row.remoteUrl, row.localUrl]]
      : [];
  });
  return new Map(entries);
}

function originalImageUrls(row: Record<string, unknown>): string[] {
  const archived = archivedSourceImageMap(row.archived_source_images);
  const ordered = [
    ...imageUrls(row.source_main_images),
    ...imageUrls(row.source_detail_images)
  ];
  return [...new Set(ordered)].flatMap((url) => {
    const visible = archived.get(url) ?? sourceImageProxyPath(url);
    return visible ? [visible] : [];
  });
}

function processedImageUrls(value: unknown): string[] {
  return strings(value).flatMap((raw) => {
    if (/^asset_[A-Za-z0-9_-]+$/.test(raw)) {
      return [`/api/v1/assets/${encodeURIComponent(raw)}/content`];
    }
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? [url.href] : [];
    } catch {
      return [];
    }
  });
}
```

In `toPoolItem()` compute both arrays once, set:

```ts
const originalImages = originalImageUrls(row);
const processedImages = processedImageUrls(row.canvas_outputs);
```

and return:

```ts
thumbnailUrl: originalImages[0] ?? optionalString(row, "thumbnail_url"),
originalImageUrls: originalImages,
processedImageUrls: processedImages,
```

- [ ] **Step 6: Run the service test and verify GREEN**

Run:

```bash
pnpm --filter @tk/web exec vitest run src/server/services/product-service.test.ts
```

Expected: all service projection tests PASS.

- [ ] **Step 7: Commit Task 2 only if no pre-existing service hunks are staged**

Use interactive staging because `product-service.ts` already contains unrelated uncommitted work:

```bash
git add packages/contracts/src/read-models.ts apps/web/src/server/services/product-service.test.ts
git add -p apps/web/src/server/services/product-service.ts
git diff --cached
```

If `git diff --cached` contains older service work, unstage the overlapping file:

```bash
git restore --staged apps/web/src/server/services/product-service.ts
```

Otherwise commit:

```bash
git commit -m "feat(products): project source and processed image galleries"
```

---

### Task 3: Gallery and Preview Dialog Components

**Files:**
- Create: `apps/web/src/components/products/image-preview-dialog.tsx`
- Create: `apps/web/src/components/products/product-image-gallery.tsx`
- Create: `apps/web/src/components/products/product-image-gallery.test.tsx`

**Interfaces:**
- Produces: `ImagePreviewDialog`
- Produces: `ProductImageGallery({ productId, originalImageUrls, processedImageUrls })`
- Consumes: two read-only image URL arrays from `ProductPoolItemV1`

- [ ] **Step 1: Write failing gallery tests**

The test fixture must render:

```tsx
<ProductImageGallery
  productId="prod-1"
  originalImageUrls={["/source-1.jpg", "/source-2.jpg", "/source-3.jpg"]}
  processedImageUrls={["/canvas-1.jpg", "/canvas-2.jpg"]}
/>
```

Assert:

```ts
expect(screen.getByRole("region", { name: "商品 prod-1 原产品图" }))
  .toHaveTextContent("原产品图3");
expect(screen.getByRole("region", { name: "商品 prod-1 洗图后的图" }))
  .toHaveTextContent("洗图后的图2");
expect(screen.getAllByRole("button", { name: /放大原产品图/ })).toHaveLength(3);
expect(screen.getAllByRole("button", { name: /放大洗图后的图/ })).toHaveLength(2);
```

Add interaction assertions:

```ts
const opener = screen.getByRole("button", { name: "放大原产品图 1/3" });
fireEvent.click(opener);
expect(screen.getByRole("dialog", { name: "原产品图预览" })).toBeInTheDocument();
expect(screen.getByText("1 / 3")).toBeInTheDocument();
fireEvent.keyDown(document, { key: "ArrowRight" });
expect(screen.getByText("2 / 3")).toBeInTheDocument();
fireEvent.keyDown(document, { key: "Escape" });
expect(screen.queryByRole("dialog")).toBeNull();
expect(opener).toHaveFocus();
```

Add empty and failure assertions:

```ts
expect(screen.getByText("未采集到可用原图")).toBeInTheDocument();
expect(screen.getByText("等待生成")).toBeInTheDocument();
fireEvent.error(screen.getByRole("img", { name: "原产品图 1" }));
expect(screen.getByText("图片加载失败")).toBeInTheDocument();
expect(screen.getByRole("img", { name: "原产品图 2" })).toBeInTheDocument();
```

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
pnpm --filter @tk/web exec vitest run \
  src/components/products/product-image-gallery.test.tsx
```

Expected: FAIL because the gallery component does not exist.

- [ ] **Step 3: Implement `ImagePreviewDialog`**

Use this public contract:

```ts
export type ImagePreviewDialogProps = Readonly<{
  kind: "原产品图" | "洗图后的图";
  images: readonly string[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onClose: () => void;
}>;
```

The component must:

- render `role="dialog"` with `aria-modal="true"` and `${kind}预览`;
- register `ArrowLeft`, `ArrowRight`, and `Escape` on `document`;
- wrap navigation from the last image to the first and vice versa;
- close on the close button or backdrop;
- render a filmstrip whose buttons set the active index;
- focus its close button on mount.

- [ ] **Step 4: Implement `ProductImageGallery`**

Use this public contract:

```ts
export type ProductImageGalleryProps = Readonly<{
  productId: string;
  originalImageUrls: readonly string[];
  processedImageUrls: readonly string[];
}>;
```

The component owns:

```ts
type PreviewState = Readonly<{
  kind: "original" | "processed";
  activeIndex: number;
}> | null;
```

Render two always-visible sections. Each successful image uses `loading="lazy"` and a button label:

```ts
`放大${kindLabel} ${index + 1}/${images.length}`
```

On close, clear preview state and call `focus()` on the exact opener stored in a ref. Store failed URLs in a `Set<string>` so one failed tile changes to `图片加载失败` without removing siblings.

- [ ] **Step 5: Run component tests and verify GREEN**

Run:

```bash
pnpm --filter @tk/web exec vitest run \
  src/components/products/product-image-gallery.test.tsx
```

Expected: all gallery and dialog tests PASS.

- [ ] **Step 6: Commit the isolated new component files**

```bash
git add apps/web/src/components/products/image-preview-dialog.tsx \
  apps/web/src/components/products/product-image-gallery.tsx \
  apps/web/src/components/products/product-image-gallery.test.tsx
git diff --cached
git commit -m "feat(products): add split image gallery and preview dialog"
```

---

### Task 4: Integrate the Gallery into `/products/`

**Files:**
- Modify: `apps/web/src/components/products/product-table.tsx:3-170`
- Modify: `apps/web/src/components/products/product-table.test.tsx`
- Modify: `apps/web/src/app/globals.css:179-307`
- Modify: `apps/web/src/app/products/page.test.tsx`
- Modify: `apps/web/src/app/final-review.test.tsx`
- Modify: `apps/web/src/components/products/product-row-view.test.ts`
- Modify: `apps/web/src/components/products/product-workbench.projection.test.ts`
- Modify: `apps/web/src/components/products/product-workbench.state.test.ts`
- Modify: `apps/web/src/lib/fixtures.ts`

**Interfaces:**
- Consumes: `ProductImageGallery`
- Consumes: `item.originalImageUrls` and `item.processedImageUrls`
- Preserves: all current table selection, action, stage filtering and detail links

- [ ] **Step 1: Add required arrays to test factories and fixtures**

Every `ProductPoolItemV1` factory must define:

```ts
originalImageUrls: ["/api/v1/source-images?url=https%3A%2F%2Fcbu01.alicdn.com%2Fmain.jpg"],
processedImageUrls: [],
```

Use realistic per-test overrides where Canvas is already succeeded:

```ts
processedImageUrls: [
  "https://canvas.example/output-1.png",
  "https://canvas.example/output-2.png"
]
```

- [ ] **Step 2: Write failing ProductTable integration assertions**

In `product-table.test.tsx`, render an item with two original and one processed image, then assert:

```ts
const productGallery = screen.getByRole("group", {
  name: "商品 892408514788 图片"
});
expect(productGallery).toBeInTheDocument();
expect(within(productGallery).getByRole("region", {
  name: "商品 892408514788 原产品图"
})).toBeInTheDocument();
expect(within(productGallery).getByRole("region", {
  name: "商品 892408514788 洗图后的图"
})).toBeInTheDocument();
expect(within(productGallery).getAllByRole("button", {
  name: /放大原产品图/
})).toHaveLength(2);
```

Also assert the existing `查看详情` and `开始处理` controls remain present.

- [ ] **Step 3: Run ProductTable tests and verify RED**

Run:

```bash
pnpm --filter @tk/web exec vitest run \
  src/components/products/product-table.test.tsx
```

Expected: FAIL because the table does not render `ProductImageGallery`.

- [ ] **Step 4: Insert a gallery row under each product summary row**

Import `Fragment` and `ProductImageGallery`. Wrap the current summary `<tr>` and the new gallery `<tr>` in one keyed `Fragment`. Keep the current ten `<td>` elements from `product-table.tsx:108-167` byte-for-byte unchanged inside the summary row, move `key={productId}` from the summary row to the `Fragment`, add `data-product-summary-for={productId}` to the summary row, then insert this exact sibling row immediately after it:

```tsx
<tr className="tk-product-table__gallery-row" data-product-gallery-for={productId}>
  <td colSpan={10}>
    <div role="group" aria-label={`商品 ${productId} 图片`}>
      <ProductImageGallery
        productId={productId}
        originalImageUrls={item.originalImageUrls}
        processedImageUrls={item.processedImageUrls}
      />
    </div>
  </td>
</tr>
```

Do not add a gallery toggle. Both sections render immediately.

- [ ] **Step 5: Add production CSS from the approved prototype**

Port the prototype’s focused styles into `globals.css` with the existing `tk-` namespace:

- `.tk-product-table__gallery-row`
- `.tk-product-image-gallery`
- `.tk-product-image-gallery__section`
- `.tk-product-image-gallery__label`
- `.tk-product-image-gallery__scroller`
- `.tk-product-image-gallery__strip`
- `.tk-product-image-gallery__tile`
- `.tk-product-image-gallery__empty`
- `.tk-image-preview`
- `.tk-image-preview__backdrop`
- `.tk-image-preview__stage`
- `.tk-image-preview__filmstrip`

Enforce these layout values:

```css
.tk-product-table__gallery-row > td {
  padding: 0;
  background: #fff;
}

.tk-product-image-gallery__section {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr) 44px;
  min-height: 122px;
}

.tk-product-image-gallery__scroller {
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.tk-product-image-gallery__tile {
  width: 86px;
  height: 86px;
  flex: 0 0 86px;
}
```

The modal must use a fixed backdrop with a higher z-index than the sticky table header and constrain the main image with `object-fit: contain`.

- [ ] **Step 6: Run table, page, projection and state tests**

Run:

```bash
pnpm --filter @tk/web exec vitest run \
  src/components/products/product-table.test.tsx \
  src/app/products/page.test.tsx \
  src/app/final-review.test.tsx \
  src/components/products/product-row-view.test.ts \
  src/components/products/product-workbench.projection.test.ts \
  src/components/products/product-workbench.state.test.ts
```

Expected: all selected suites PASS.

- [ ] **Step 7: Run web typecheck**

Run:

```bash
pnpm --filter @tk/web typecheck
```

Expected: exit code 0; every `ProductPoolItemV1` fixture includes both arrays.

- [ ] **Step 8: Stage only new gallery integration hunks**

Because `product-table.tsx` and `globals.css` already contain unrelated modifications:

```bash
git add -p apps/web/src/components/products/product-table.tsx \
  apps/web/src/components/products/product-table.test.tsx \
  apps/web/src/app/globals.css
git add apps/web/src/app/products/page.test.tsx \
  apps/web/src/app/final-review.test.tsx \
  apps/web/src/components/products/product-row-view.test.ts \
  apps/web/src/components/products/product-workbench.projection.test.ts \
  apps/web/src/components/products/product-workbench.state.test.ts \
  apps/web/src/lib/fixtures.ts
git diff --cached
```

Commit only if the staged diff contains no older work:

```bash
git commit -m "feat(products): show split image galleries in product rows"
```

---

### Task 5: Browser Regression and Live Acceptance

**Files:**
- Modify: `e2e/browser-workbench.spec.ts`

**Interfaces:**
- Consumes: `/products/` UI and `/api/v1/products` image arrays
- Verifies: direct display, strict section separation, stable height, modal navigation

- [ ] **Step 1: Extend the deterministic browser fixture**

Change `revision_browser_a.source_payload` to:

```json
{
  "mainImages": [
    { "url": "https://cbu01.alicdn.com/source-a-1.jpg" },
    { "url": "https://cbu01.alicdn.com/source-a-2.jpg" }
  ],
  "detailImages": [
    { "url": "https://cbu01.alicdn.com/source-a-1.jpg" },
    { "url": "https://img.alicdn.com/source-a-3.jpg" }
  ]
}
```

Insert a latest Canvas run for `revision_browser_a`:

```sql
INSERT INTO canvas_runs
  (id, product_id, revision_id, state, outputs, template_id, template_version)
VALUES
  ('canvas_browser_a', 'product_browser_a', 'revision_browser_a', 'succeeded',
   '["https://canvas.example/output-1.png","https://canvas.example/output-2.png"]'::jsonb,
   'template_browser', 1);
```

- [ ] **Step 2: Write the failing browser test**

Before navigation, fulfill image requests with a valid 1×1 PNG:

```ts
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
await page.route("**/api/v1/source-images?**", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: onePixelPng })
);
await page.route("https://canvas.example/**", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: onePixelPng })
);
```

Assert:

```ts
await page.goto("/products/");
const gallery = page.getByRole("group", { name: "商品 product_browser_a 图片" });
await expect(gallery).toBeVisible();
await expect(gallery.getByRole("button", { name: /放大原产品图/ })).toHaveCount(3);
await expect(gallery.getByRole("button", { name: /放大洗图后的图/ })).toHaveCount(2);

await gallery.getByRole("button", { name: "放大原产品图 1/3" }).click();
const dialog = page.getByRole("dialog", { name: "原产品图预览" });
await expect(dialog).toBeVisible();
await expect(dialog).toContainText("1 / 3");
await page.keyboard.press("ArrowRight");
await expect(dialog).toContainText("2 / 3");
await page.keyboard.press("Escape");
await expect(dialog).toBeHidden();
```

Measure the two gallery sections and assert each height is at most `140` pixels. Keep the existing document horizontal-overflow assertion.

- [ ] **Step 3: Run the browser test and verify RED**

Prerequisite: the shell already exports the loopback `TEST_DATABASE_URL` ending in `_test`.

Run:

```bash
pnpm exec playwright test e2e/browser-workbench.spec.ts --reporter=line
```

Expected: the new gallery assertion FAILS before Task 4 integration is present.

- [ ] **Step 4: Run the browser test after Tasks 1–4 and verify GREEN**

Run the same command:

```bash
pnpm exec playwright test e2e/browser-workbench.spec.ts --reporter=line
```

Expected: all browser-workbench tests PASS.

- [ ] **Step 5: Run the full feature verification gate**

Run:

```bash
pnpm --filter @tk/web exec vitest run \
  src/server/source-image-url.test.ts \
  src/app/api/v1/source-images/route.test.ts \
  src/server/services/product-service.test.ts \
  src/components/products/product-image-gallery.test.tsx \
  src/components/products/product-table.test.tsx
pnpm --filter @tk/web lint
pnpm --filter @tk/web typecheck
pnpm --filter @tk/web build
pnpm exec playwright test e2e/browser-workbench.spec.ts --reporter=line
git diff --check
git status --short
```

Expected:

- all targeted Vitest suites PASS;
- lint, typecheck and build exit 0;
- browser-workbench tests PASS;
- `git diff --check` reports no whitespace errors;
- `git status --short` still lists pre-existing unrelated files, which are not staged or deleted.

- [ ] **Step 6: Verify the actual local `/products/` data**

With the repository’s existing `pnpm start:local` service running on port 3000, use Playwright to inspect:

```js
({
  productGroups: document.querySelectorAll("[data-product-gallery-for]").length,
  originalImages: document.querySelectorAll(
    "[aria-label*='原产品图'] img"
  ).length,
  processedImages: document.querySelectorAll(
    "[aria-label*='洗图后的图'] img"
  ).length,
  openDialogs: document.querySelectorAll("[role='dialog']").length
})
```

Required result:

- `productGroups` equals the number of visible product summary rows;
- at least one current product has `originalImages > 1`;
- clicking the first original image opens exactly one dialog;
- the dialog title is `原产品图预览`;
- the batch-operation footer remains visible and unobstructed.

- [ ] **Step 7: Commit the E2E regression when isolated**

```bash
git add -p e2e/browser-workbench.spec.ts
git diff --cached
git commit -m "test(products): cover split galleries on product list"
```

If the file contains earlier unstaged work in the same hunks, leave it unstaged and report the verified E2E change in the final handoff.
