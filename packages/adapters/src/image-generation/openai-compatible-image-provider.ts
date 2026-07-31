import { externalFailure, reconcileRequiredFailure, type ImageGenerationPort } from "@tk/contracts";
import { isRetryableHttpStatus } from "../http-status.js";

const CONNECT_TIMEOUT_MS = 30_000;

export interface OpenAiCompatibleImageProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

export function createOpenAiCompatibleImageProvider(
  config: OpenAiCompatibleImageProviderConfig
): ImageGenerationPort {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async submit(input) {
      const controller = new AbortController();
      const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

      let submitted = false;
      let response: Response;
      try {
        const body = buildSubmitBody(input, config.model);

        response = await fetchImpl(`${baseUrl}/v1/images/generations`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${config.apiKey}`,
            "Idempotency-Key": String(input.idempotencyKey)
          },
          body: JSON.stringify(body)
        });
        submitted = true;
      } catch (err) {
        clearTimeout(connectTimer);
        // Network/timeout error — result unknown after transmission attempt
        throw reconcileRequiredFailure("image_submission_result_unknown", "Image submission result is unknown");
      } finally {
        clearTimeout(connectTimer);
      }

      // Timeout/disconnect during response reading maps to unknown
      if (!response.ok && isRetryableHttpStatus(response.status)) {
        throw reconcileRequiredFailure("image_submission_result_unknown", "Image submission result is unknown");
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        // Truncated/invalid JSON after successful HTTP — result unknown
        throw reconcileRequiredFailure("image_submission_result_unknown", "Image submission result is unknown");
      }

      const result = raw as Record<string, unknown>;

      // Synchronous completion: Agnes-style immediate URL response
      if (result.data && Array.isArray(result.data) && result.data.length > 0) {
        const first = result.data[0] as Record<string, unknown>;
        if (typeof first.url === "string" && first.url.length > 0) {
          return { kind: "completed", outputUrl: first.url };
        }
      }

      // Async: return remote task ID for polling
      if (typeof result.id === "string" && result.id.length > 0) {
        return { kind: "accepted", remoteTaskId: result.id };
      }

      // Unexpected shape — treat as unknown
      throw reconcileRequiredFailure("image_submission_result_unknown", "Image submission result is unknown");
    },

    async fetch(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

      try {
        const response = await fetchImpl(`${baseUrl}/v1/images/generations/${input.remoteTaskId}`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "authorization": `Bearer ${config.apiKey}`
          }
        });

        clearTimeout(timer);

        if (!response.ok) {
          if (isRetryableHttpStatus(response.status)) {
            return { state: "pending" };
          }
          return {
            state: "failed",
            failure: externalFailure("retryable", "image_fetch_failed", "Failed to fetch image generation status")
          };
        }

        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          return { state: "pending" };
        }

        const result = raw as Record<string, unknown>;

        // Completed with URL
        if (result.data && Array.isArray(result.data) && result.data.length > 0) {
          const first = result.data[0] as Record<string, unknown>;
          if (typeof first.url === "string" && first.url.length > 0) {
            return { state: "succeeded", outputUrl: first.url };
          }
        }

        // Explicit failed status
        if (result.status === "failed" || result.status === "error") {
          return {
            state: "failed",
            failure: externalFailure("retryable", "image_generation_failed", "Image generation failed on provider")
          };
        }

        // Processing/queued
        return { state: "pending" };
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          return { state: "pending" };
        }
        return { state: "pending" };
      }
    }
  };
}

function buildSubmitBody(input: Parameters<ImageGenerationPort["submit"]>[0], model: string) {
  const imageMessages: Array<{ type: "image_url"; image_url: { url: string; detail: string } }> = [];

  for (const path of input.referenceImagePaths) {
    if (path.startsWith("data:")) {
      imageMessages.push({ type: "image_url", image_url: { url: path, detail: "low" } });
    }
    // Non-data-URL paths are caller responsibility (asset staging); adapter sends prompt only.
  }

  return {
    model,
    prompt: input.prompt.prompt,
    n: 1,
    extra_body: imageMessages.length > 0 ? { image: imageMessages } : undefined
  };
}
