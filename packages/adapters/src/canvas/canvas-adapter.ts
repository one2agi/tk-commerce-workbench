import {
  externalFailure,
  reconcileRequiredFailure,
  type CanvasFetchOutputsResult,
  type CanvasPort,
  type CanvasReadCapacityResult,
  type CanvasSubmitResult
} from "@tk/contracts";
import { createHash } from "node:crypto";
import { isRetryableHttpStatus } from "../http-status.js";
import { assertPublicHttpUrl, createSafeImageDownloader, type ResolveHost } from "../security/safe-image-download.js";

export interface CanvasAdapterConfig {
  readonly baseUrl: string;
  readonly canvasId: string;
  readonly workflowName?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly downloadImage?: (url: string) => Promise<{ bytes: Uint8Array; finalUrl: string }>;
  readonly resolveHost?: ResolveHost;
}

type WorkflowMetadata = {
  workflow_id?: string;
  workflow_key?: string;
  name?: string;
  input_image_count?: number;
  node_count?: number;
  connection_count?: number;
  workflow_version?: number;
  expected_output_count?: number;
  run_order?: string[];
};

type OutputCandidate = { url?: string; width?: number; height?: number; sha256?: string } | string;

export function createCanvasAdapter(config: CanvasAdapterConfig): CanvasPort {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const downloadImage = config.downloadImage ?? createSafeImageDownloader({ timeoutMs });

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) {
        throw externalFailure(isRetryableHttpStatus(response.status) ? "retryable" : "fatal", `canvas.http_${response.status}`, "Canvas request failed");
      }
      return await response.json();
    } catch (error) {
      if (isExternalFailure(error)) throw error;
      throw externalFailure("retryable", "canvas.network", "Canvas is temporarily unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async function readWorkflowCapacity(workflowId: string): Promise<CanvasReadCapacityResult> {
      const raw = await request(`/api/automation/canvases/${encodeURIComponent(config.canvasId)}/workflows`) as { workflows?: WorkflowMetadata[] } | WorkflowMetadata[];
      const workflows = Array.isArray(raw) ? raw : raw.workflows ?? [];
      const workflow = workflows.find((item) => item.workflow_id === workflowId || item.workflow_key === workflowId || item.name === workflowId);
      if (!workflow) throw externalFailure("needs_input", "canvas.workflow_not_found", "Canvas workflow was not found");
      const inputCapacity = workflow.input_image_count ?? 0;
      const expectedOutputCount = workflow.expected_output_count ?? (workflow.run_order ?? []).filter((id) => id.startsWith("generator_")).length;
      if (!Number.isInteger(inputCapacity) || inputCapacity < 1 || expectedOutputCount < 1) {
        throw externalFailure("needs_input", "canvas.workflow_topology_changed", "Canvas workflow topology requires review");
      }
      const result = Object.freeze({ workflowId: workflow.workflow_id ?? workflowId, workflowVersion: workflow.workflow_version ?? deriveTopologyVersion(workflow), inputCapacity, expectedOutputCount });
      return result;
  }

  return {
    readWorkflowCapacity,

    async submit(input): Promise<CanvasSubmitResult> {
      const observed = await readWorkflowCapacity(input.workflowId);
      if (observed.workflowVersion !== input.workflowVersion) {
        throw externalFailure("needs_input", "canvas.workflow_version_changed", "Canvas workflow changed after it was reviewed");
      }
      const imageUrls = [...input.imageUrls, ...input.referenceImageUrls];
      if (imageUrls.length < 1 || imageUrls.length > observed.inputCapacity) {
        throw externalFailure("needs_input", "canvas.invalid_image_count", "Canvas image count is outside the current workflow capacity");
      }
      if (new Set(imageUrls).size !== imageUrls.length || imageUrls.some((url) => !isPublicHttpUrl(url))) {
        throw externalFailure("needs_input", "canvas.invalid_image_urls", "Canvas requires unique publicly accessible image URLs");
      }
      try {
        await Promise.all(imageUrls.map((url) => assertPublicHttpUrl(url, config.resolveHost)));
      } catch {
        throw externalFailure("needs_input", "canvas.invalid_image_urls", "Canvas requires unique publicly accessible image URLs");
      }
      let raw: { task_id?: string; taskId?: string; id?: string };
      try {
        raw = await request("/api/automation/workflow-runs", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": String(input.idempotencyKey) },
          body: JSON.stringify({
            workflow: { prompt_context: { source_locale: input.promptContext.sourceLocale, target_locale: input.promptContext.targetLocale, style: input.promptContext.style } },
            canvas_id: config.canvasId,
            canvas_workflow_id: observed.workflowId,
            canvas_workflow_name: config.workflowName ?? "",
            image_urls: imageUrls,
            callback_url: ""
          })
        }) as typeof raw;
      } catch (error) {
        if (isExternalFailure(error) && error.kind === "retryable") {
          throw reconcileRequiredFailure("canvas.submit_result_unknown", "Canvas submission result is unknown and must be reconciled");
        }
        throw error;
      }
      const remoteTaskId = raw.task_id ?? raw.taskId ?? raw.id;
      if (!remoteTaskId) throw reconcileRequiredFailure("canvas.submit_result_unknown", "Canvas submission result is unknown and must be reconciled");
      return Object.freeze({ remoteTaskId, submittedAt: config.now?.() ?? new Date().toISOString() });
    },

    async fetchOutputs({ remoteTaskId }): Promise<CanvasFetchOutputsResult> {
      const raw = await request(`/api/automation/workflow-runs/${encodeURIComponent(remoteTaskId)}`) as {
        status?: string;
        outputs?: OutputCandidate[];
        result?: OutputCandidate[] | { outputs?: OutputCandidate[] };
      };
      const status = raw.status?.toLowerCase();
      if (status === "running" || status === "pending" || status === "queued") {
        throw externalFailure("retryable", "canvas.not_ready", "Canvas output is not ready yet");
      }
      if (status === "failed" || status === "error") {
        throw externalFailure("fatal", "canvas.remote_failed", "Canvas generation failed");
      }
      const candidates = raw.outputs ?? (Array.isArray(raw.result) ? raw.result : raw.result?.outputs) ?? [];
      const hydrated = await Promise.all(candidates.map((candidate) => normalizeOutput(candidate, baseUrl, downloadImage)));
      const outputs = hydrated.filter((item): item is NonNullable<typeof item> => item !== null);
      if (outputs.length === 0) throw externalFailure("fatal", "canvas.no_valid_outputs", "Canvas returned no valid generated images");
      return Object.freeze({ outputs });
    }
  };
}

function deriveTopologyVersion(workflow: WorkflowMetadata): number {
  const value = JSON.stringify({
    key: workflow.workflow_key ?? "",
    nodes: workflow.node_count ?? 0,
    connections: workflow.connection_count ?? 0,
    inputs: workflow.input_image_count ?? 0,
    order: workflow.run_order ?? []
  });
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) || 1;
}

async function normalizeOutput(candidate: OutputCandidate, baseUrl: string, downloadImage: (url: string) => Promise<{ bytes: Uint8Array; finalUrl: string }>) {
  const object = typeof candidate === "string" ? { url: candidate } : candidate;
  if (!object.url || !/^\/{1}(?!\/)|^https?:\/\//i.test(object.url)) return null;
  const url = new URL(object.url, `${baseUrl}/`).toString();
  try {
    // Never trust remote dimensions or hashes. The secure downloader pins validated DNS and
    // never receives the Canvas API key.
    const { bytes, finalUrl } = await downloadImage(url);
    const dimensions = readImageDimensions(bytes);
    if (!dimensions) return null;
    return Object.freeze({ url: finalUrl, ...dimensions, sha256: createHash("sha256").update(bytes).digest("hex") });
  } catch {
    return null;
  }
}

function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      const length = view.getUint16(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (length < 2) return null;
      offset += length + 2;
    }
  }
  return null;
}

function isExternalFailure(error: unknown): error is { kind: string; code: string; safeMessage: string } {
  return Boolean(error && typeof error === "object" && "kind" in error && "code" in error && "safeMessage" in error);
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const private172 = /^172\.(\d+)\./.exec(host)?.[1];
    return private172 === undefined || Number(private172) < 16 || Number(private172) > 31;
  } catch {
    return false;
  }
}
