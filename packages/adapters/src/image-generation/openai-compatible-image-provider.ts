import { externalFailure, reconcileRequiredFailure, type ImageGenerationPort } from "@tk/contracts";
import { isRetryableHttpStatus } from "../http-status.js";
import { encodeLocalImageReferences } from "./local-image-data-url.js";

const CONNECT_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 30 * 60_000;

export interface OpenAiCompatibleImageProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createOpenAiCompatibleImageProvider(
  config: OpenAiCompatibleImageProviderConfig
): ImageGenerationPort {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const urls = providerUrls(config.baseUrl);

  return {
    async submit(input) {
      if (input.references.length === 0) {
        throw externalFailure(
          "needs_input",
          "image_reference_count_invalid",
          "Image generation requires at least one source image"
        );
      }
      const body = await buildSubmitBody(input, config.model);
      const controller = new AbortController();

      let response: Response;
      try {
        response = await waitWithTimeout(fetchImpl(urls.submit, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${config.apiKey}`,
            "Idempotency-Key": String(input.idempotencyKey)
          },
          body: JSON.stringify(body)
        }), config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, controller);
      } catch {
        throw reconcileRequiredFailure("image_submission_result_unknown", "Image submission result is unknown");
      }

      // Timeout/disconnect during response reading maps to unknown
      if (!response.ok && isRetryableHttpStatus(response.status)) {
        throw reconcileRequiredFailure("image_submission_result_unknown", "Image submission result is unknown");
      }

      let raw: unknown;
      try {
        raw = await waitWithTimeout(
          response.json(),
          config.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS,
          controller
        );
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
        if (typeof first.task_id === "string" && first.task_id.length > 0) {
          return { kind: "accepted", remoteTaskId: first.task_id };
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

      try {
        const response = await waitWithTimeout(fetchImpl(`${urls.tasks}/${input.remoteTaskId}`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "authorization": `Bearer ${config.apiKey}`
          }
        }), config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, controller);

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
          raw = await waitWithTimeout(
            response.json(),
            config.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS,
            controller
          );
        } catch {
          return { state: "pending" };
        }

        const result = raw as Record<string, unknown>;
        const providerData = result.data && !Array.isArray(result.data)
          ? result.data as Record<string, unknown>
          : undefined;
        const providerResult = providerData?.result as Record<string, unknown> | undefined;
        const providerImages = providerResult?.images;
        if (Array.isArray(providerImages) && providerImages.length > 0) {
          const firstImage = providerImages[0] as Record<string, unknown>;
          const imageUrls = firstImage.url;
          if (Array.isArray(imageUrls) && typeof imageUrls[0] === "string" && imageUrls[0].length > 0) {
            return { state: "succeeded", outputUrl: imageUrls[0] };
          }
        }

        // Completed with URL
        if (result.data && Array.isArray(result.data) && result.data.length > 0) {
          const first = result.data[0] as Record<string, unknown>;
          if (typeof first.url === "string" && first.url.length > 0) {
            return { state: "succeeded", outputUrl: first.url };
          }
        }

        // Explicit failed status
        if (result.status === "failed" || result.status === "error" || providerData?.status === "failed") {
          return {
            state: "failed",
            failure: externalFailure("retryable", "image_generation_failed", "Image generation failed on provider")
          };
        }

        // Processing/queued
        return { state: "pending" };
      } catch {
        return { state: "pending" };
      }
    }
  };
}

async function buildSubmitBody(input: Parameters<ImageGenerationPort["submit"]>[0], model: string) {
  const imageMessages = await encodeLocalImageReferences(input.references);
  const { extra_body: rawExtraBody, ...parameters } = input.parameters;
  const extraBody = rawExtraBody && typeof rawExtraBody === "object" && !Array.isArray(rawExtraBody)
    ? rawExtraBody as Record<string, unknown>
    : {};

  return {
    ...parameters,
    model,
    prompt: input.prompt.prompt,
    n: 1,
    image_urls: imageMessages.map((message) => message.image_url.url),
    extra_body: {
      ...extraBody,
      image: imageMessages.map((message) => message.image_url.url)
    }
  };
}

function providerUrls(rawBaseUrl: string): { submit: string; tasks: string } {
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  if (baseUrl.endsWith("/v1/images/generations")) {
    const origin = baseUrl.slice(0, -"/v1/images/generations".length);
    return { submit: baseUrl, tasks: `${origin}/v1/tasks` };
  }
  if (baseUrl.endsWith("/v1")) {
    return { submit: `${baseUrl}/images/generations`, tasks: `${baseUrl}/tasks` };
  }
  return { submit: `${baseUrl}/v1/images/generations`, tasks: `${baseUrl}/v1/tasks` };
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("image_provider_timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
