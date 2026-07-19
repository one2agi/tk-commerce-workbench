# Loopback Same-Origin Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development + superpowers:verification-before-completion.

**Goal:** 修复 `rejectUnsafeBrowserMutation()` 把 `127.0.0.1` 与 `localhost` 当作不同 origin 的问题，让本地开发者在浏览器用 `http://127.0.0.1:3000/` 访问时能正常提交 JSON mutation。

**Architecture:** 不放宽 CSRF 防护。Loopback 三个常见别名（`127.0.0.1` / `localhost` / `::1`）在相同 scheme + port 下视为同一 origin，因为它们在物理上都指向本机，无法被远程脚本跨域访问。这是"loopback 命名变体归一化"，不是"接受任意 Origin"。

**Tech Stack:** TypeScript, Vitest, Next.js App Router route handlers.

## Bug Reproduction (already verified)

```bash
# 测试 A：localhost 路径 → 业务层 OK
curl -s -X POST -w "\nHTTP %{http_code}\n" http://localhost:3000/api/v1/automation-runs \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -d '{}'
# → HTTP 400 (invalid_request，业务层到了)

# 测试 B：127.0.0.1 路径 → 被 same_origin 拦下
curl -s -X POST -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/api/v1/automation-runs \
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:3000" -d '{}'
# → HTTP 403 {"error":"same_origin_json_required"}
```

Root cause in `apps/web/src/server/auth/loopback.ts` line 14:
```ts
return new URL(origin).origin === new URL(request.url).origin
  ? null
  : Response.json({ error: "same_origin_json_required" }, { status: 403 });
```
严格相等比较。Next.js dev server 在 `Host: 127.0.0.1:3000` 时把 `request.url` 解析为 `http://localhost:3000/...`（具体取决于 dev server 实现），浏览器 `Origin: http://127.0.0.1:3000` 与之不匹配 → 403。

## File Structure

- Modify: `apps/web/src/server/auth/loopback.ts`
  - 抽出 `loopbackAlias(hostname: string): string` helper
  - 抽出 `isSameLoopbackOrigin(request: Request, origin: string): boolean` helper
  - `rejectUnsafeBrowserMutation()` 用新 helper 替代严格相等比较

- Add or modify: `apps/web/src/server/auth/loopback.test.ts`
  - RED: 新增 "127.0.0.1 origin + 127.0.0.1 request URL passes"
  - RED: 新增 "localhost origin + 127.0.0.1 request URL passes"
  - RED: 新增 "127.0.0.1 origin + localhost request URL passes"
  - RED: 新增 "different port rejected"
  - RED: 新增 "different scheme rejected"
  - RED: 新增 "non-loopback origin rejected"
  - 已有 happy-path 测试保持 GREEN

## Global Constraints

- 不暴露 .env / 妙手密钥 / LLM key / Canvas 配置 / 扩展令牌
- 不动 14 个 plan 外 dirty files
- 不放宽对真正跨域 Origin 的拒绝（evil.com 仍然 403）
- 不放宽对 loopback_only 的检查（ALLOW_LAN=false 时仍然只接受 loopback）
- TDD 铁律：先 RED 测试看到失败，再 GREEN
- 不 commit（让 reviewer 决定）

---

## Task 1: Loopback Same-Origin Alias

**Files:**
- Modify: `apps/web/src/server/auth/loopback.ts`
- Modify: `apps/web/src/server/auth/loopback.test.ts`

**Interfaces:**
- Consumes: `request: Request`, `origin: string | null`
- Produces: `loopbackAlias()`, `isSameLoopbackOrigin()`，原 `rejectUnsafeBrowserMutation` 行为不变但支持 loopback 别名

- [ ] **Step 1: Locate test file and read current assertions**

Run:
```bash
ls apps/web/src/server/auth/
cat apps/web/src/server/auth/loopback.test.ts 2>/dev/null || echo "no test file"
```

If no test file exists, create `apps/web/src/server/auth/loopback.test.ts` with the boilerplate below.

- [ ] **Step 2: Write RED tests for the alias behavior**

In `loopback.test.ts` (create or extend):

```ts
import { describe, it, expect } from "vitest";
import { rejectUnsafeBrowserMutation } from "./loopback";

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

describe("rejectUnsafeBrowserMutation loopback alias", () => {
  it("accepts 127.0.0.1 origin against localhost request URL", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000"
    });
    expect(rejectUnsafeBrowserMutation(req)).toBeNull();
  });

  it("accepts localhost origin against 127.0.0.1 request URL", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://localhost:3000"
    });
    expect(rejectUnsafeBrowserMutation(req)).toBeNull();
  });

  it("accepts ::1 origin against 127.0.0.1 request URL", () => {
    const req = makeRequest("http://127.0.0.1:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://[::1]:3000"
    });
    expect(rejectUnsafeBrowserMutation(req)).toBeNull();
  });

  it("rejects different port even on same loopback alias", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3100"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects different scheme", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "https://localhost:3000"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects non-loopback origin", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json",
      origin: "http://evil.com"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("preserves existing behavior: missing Origin rejected", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "application/json"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("preserves existing behavior: wrong Content-Type rejected", () => {
    const req = makeRequest("http://localhost:3000/api/v1/automation-runs", {
      "content-type": "text/plain",
      origin: "http://localhost:3000"
    });
    const res = rejectUnsafeBrowserMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run tests and confirm RED**

```bash
pnpm --filter @tk/web test -- loopback.test.ts
```

Expected before implementation: alias tests FAIL with status 403 from the strict comparison.

- [ ] **Step 4: Update loopback.ts**

In `apps/web/src/server/auth/loopback.ts`, replace the strict origin equality with loopback alias comparison:

```ts
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function loopbackAlias(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) ? "loopback" : normalized;
}

function isSameLoopbackOrigin(requestUrl: string, originHeader: string): boolean {
  let reqUrl: URL;
  let oriUrl: URL;
  try {
    reqUrl = new URL(requestUrl);
    oriUrl = new URL(originHeader);
  } catch {
    return false;
  }
  if (reqUrl.protocol !== oriUrl.protocol) return false;
  if (reqUrl.port !== oriUrl.port) return false;
  return loopbackAlias(reqUrl.hostname) === loopbackAlias(oriUrl.hostname);
}

export function rejectUnsafeBrowserMutation(request: Request): Response | null {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get("origin");
  if (contentType !== "application/json" || !origin) {
    return Response.json({ error: "same_origin_json_required" }, { status: 403 });
  }
  return isSameLoopbackOrigin(request.url, origin)
    ? null
    : Response.json({ error: "same_origin_json_required" }, { status: 403 });
}
```

Keep `rejectNonLoopback` exactly as it was — that check is separate and correct.

- [ ] **Step 5: Run tests and confirm GREEN**

```bash
pnpm --filter @tk/web test -- loopback.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 6: Run full web app focused tests + typecheck**

```bash
pnpm --filter @tk/web typecheck
pnpm --filter @tk/web test -- loopback.test.ts final-review.test.tsx api
```

Expected: all pass; no regressions in existing same-origin/loopback tests.

- [ ] **Step 7: Live curl verification**

```bash
# 127.0.0.1 同源 POST 现在应到业务层（即使 schema 错也是 400 而不是 403）
curl -s -X POST -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/api/v1/automation-runs \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:3000" \
  -d '{}'
```

Expected: HTTP 400 (业务层 invalid_request)，不再 403。

## Rollback Plan

1. Revert `apps/web/src/server/auth/loopback.ts` to use strict origin equality.
2. Re-run `pnpm --filter @tk/web test -- loopback.test.ts` to confirm RED tests fail again.
3. Commit revert; users can use `localhost:3000` as workaround.

## Product Acceptance Criteria

- 浏览器 `http://127.0.0.1:3000/` 同源 fetch 不再 403。
- `http://evil.com` 仍然 403（CSRF 防护不放松）。
- 不同端口 / 不同 scheme 仍然 403。
- `rejectNonLoopback` 行为不变（ALLOW_LAN=false 时仍只接受 loopback）。
