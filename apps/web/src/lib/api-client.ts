// Typed API client. Wave 1 only knows about the two human-gate commands
// declared in @tk/contracts (StartAutomationV1 is the only one the Workbench
// UI dispatches). Wave 2 will plug real HTTP/fetch transport in here; for now
// every method just validates against the zod schema and routes through the
// injected send() transport.

import { StartAutomationV1, type StartAutomationV1 as StartAutomationV1T } from "@tk/contracts/commands";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

export type ApiClient = Readonly<{
  send: (command: string, payload: unknown) => Promise<{
    runs: Array<{ revisionId: string; runId: string; created: boolean }>;
  }>;
}>;

export function dispatchStartAutomation(
  client: ApiClient,
  input: Omit<StartAutomationV1T, "version">
): Promise<{ runs: Array<{ revisionId: string; runId: string; created: boolean }> }> {
  const payload: StartAutomationV1T = { version: 1, ...input };
  const parsed = StartAutomationV1.safeParse(payload);
  if (!parsed.success) {
    return Promise.reject(new Error(
      `StartAutomationV1 payload rejected: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    ));
  }
  return client.send("StartAutomationV1", parsed.data);
}

export function createHttpApiClient(fetcher: typeof fetch = fetch): ApiClient {
  return {
    async send(command, payload) {
      if (command !== "StartAutomationV1") throw new Error("unsupported_command");
      const response = await fetcher("/api/v1/automation-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`automation_start_failed:${response.status}`);
      return response.json();
    }
  };
}

export type BatchProductAction = "confirm_miaoshou_edit" | "retry_from_failure";
export type BatchProductActionResult = Readonly<{
  results: Array<{ productId: string; ok: boolean; code?: string }>;
}>;

const BATCH_RESULT_CODE_LABELS: Readonly<Record<string, string>> = {
  approval_preview_not_ready: "审批快照尚未准备好",
  rerun_not_supported_for_state: "当前状态不支持重试",
  product_not_found: "商品不存在",
  validation_failed: "请求参数不完整"
};

export function summarizeBatchProductActionResult(
  actionLabel: string,
  result: BatchProductActionResult
): string {
  const successCount = result.results.filter((item) => item.ok).length;
  const failed = result.results.filter((item) => !item.ok);
  const failedText = failed.length > 0
    ? `（${failed.slice(0, 3).map((item) =>
        `${item.productId}：${item.code ? BATCH_RESULT_CODE_LABELS[item.code] ?? item.code : "处理失败"}`
      ).join("；")}${failed.length > 3 ? "；…" : ""}）`
    : "";
  return `${actionLabel}：${successCount} 个成功，${failed.length} 个失败${failedText}`;
}

export async function dispatchBatchProductAction(
  fetcher: typeof fetch,
  body: { action: BatchProductAction; productIds: readonly string[] }
): Promise<BatchProductActionResult> {
  const response = await fetcher("/api/v1/products/batch-actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json() as Partial<BatchProductActionResult> & { error?: string };
  if (!response.ok || !Array.isArray(result.results)) {
    throw new Error(result.error ?? "batch_product_action_failed");
  }
  return { results: result.results };
}

export async function fetchProductPool(
  fetcher: typeof fetch = fetch
): Promise<{ items: ProductPoolItemV1[] }> {
  const response = await fetcher("/api/v1/products", { method: "GET" });
  const result = await response.json() as Partial<{ items: ProductPoolItemV1[] }> & { error?: string };
  if (!response.ok || !Array.isArray(result.items)) {
    throw new Error(result.error ?? "product_pool_fetch_failed");
  }
  return { items: result.items };
}
