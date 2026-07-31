import { externalFailure, type ImagePromptPlannerPort, type PlannedImagePromptV1 } from "@tk/contracts";
import { isRetryableHttpStatus } from "../http-status.js";
import { plannerAuthFailed, plannerRateLimited, plannerRetryable, plannerSchemaInvalid, plannerTimeout } from "./provider-errors.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB per image

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface OpenAiImagePlannerConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createOpenAiImagePlanner(config: OpenAiImagePlannerConfig): ImagePromptPlannerPort {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async plan(input): Promise<{ prompts: PlannedImagePromptV1[] }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);

      // Build image data URLs from local paths after MIME and size validation
      const imageMessages = await buildImageMessages(input.localImagePaths, fetchImpl);

      try {
        const result = await callWithRepair(input, imageMessages, fetchImpl, baseUrl, config.apiKey, config.model, controller.signal);
        return result;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

async function buildImageMessages(
  localImagePaths: string[],
  fetchImpl: typeof fetch
): Promise<Array<{ type: "image_url"; image_url: { url: string; detail: string } }>> {
  const messages: Array<{ type: "image_url"; image_url: { url: string; detail: string } }> = [];

  for (const path of localImagePaths) {
    if (path.startsWith("data:")) {
      // Validate data URL before including
      const mimeMatch = path.match(/^data:([^;]+);base64,/);
      if (!mimeMatch) continue;
      const mime = mimeMatch[1]!;
      if (!ALLOWED_IMAGE_MIMES.has(mime)) continue;

      // Check size (base64 adds ~33% overhead; approximate)
      const base64Content = path.split(",")[1] ?? "";
      const byteSize = Math.ceil((base64Content.length * 3) / 4);
      if (byteSize > MAX_IMAGE_BYTES) continue;

      messages.push({ type: "image_url", image_url: { url: path, detail: "low" } });
    } else {
      // For file paths, read and convert to data URL if within limits
      try {
        const response = await fetchImpl(`file://${path}`);
        if (!response.ok) continue;
        const blob = await response.blob();
        if (!ALLOWED_IMAGE_MIMES.has(blob.type)) continue;
        const arrayBuffer = await blob.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) continue;
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        const dataUrl = `data:${blob.type};base64,${base64}`;
        messages.push({ type: "image_url", image_url: { url: dataUrl, detail: "low" } });
      } catch {
        continue;
      }
    }
  }

  return messages;
}

async function callWithRepair(
  input: Parameters<ImagePromptPlannerPort["plan"]>[0],
  imageMessages: Array<{ type: "image_url"; image_url: { url: string; detail: string } }>,
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
  signal: AbortSignal
): Promise<{ prompts: PlannedImagePromptV1[] }> {
  // First attempt
  const firstResult = await makePlanCall(input, imageMessages, fetchImpl, baseUrl, apiKey, model, signal, false);
  if (firstResult.ok) return firstResult.value;

  // Only repair on schema/parse errors (invalidContent indicates the LLM returned non-JSON or bad schema)
  // HTTP errors (429, 401, 403, 502, etc.) should surface immediately without repair
  if (firstResult.invalidContent === undefined) {
    throw firstResult.error;
  }

  // Bounded repair: one additional attempt with just the invalid JSON (no credentials or images)
  const repairResult = await makeRepairCall(input, fetchImpl, baseUrl, apiKey, model, signal, firstResult.invalidContent);
  if (repairResult.ok) return repairResult.value;

  // All attempts exhausted - repair also failed, throw retryable to allow retry
  throw plannerRetryable();
}

async function makePlanCall(
  input: Parameters<ImagePromptPlannerPort["plan"]>[0],
  imageMessages: Array<{ type: "image_url"; image_url: { url: string; detail: string } }>,
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
  signal: AbortSignal,
  isRepair: boolean
): Promise<{ ok: true; value: { prompts: PlannedImagePromptV1[] } } | { ok: false; error: ReturnType<typeof externalFailure>; invalidContent?: string }> {
  const textContent = buildPromptText(input);

  const messages: Record<string, unknown>[] = [
    { role: "system", content: "You are an image prompt planner. Return JSON with a 'prompts' array. Each prompt must have: slot (1-indexed), role, prompt (max 4000 chars), mustPreserve (array of facts to include), forbidden (array of prohibited phrases). Ensure exactly the requested number of prompts." },
    { role: "user", content: [
      { type: "text", text: textContent },
      ...imageMessages
    ]}
  ];

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
        "idempotency-key": String(input.idempotencyKey)
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: isRepair ? [{ role: "user", content: `Repair this invalid JSON: ${input}` }] : messages,
        response_format: { type: "json_schema", json_schema: { name: "image_plan", strict: true, schema: planSchema } }
      })
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: plannerTimeout() };
    }
    return { ok: false, error: externalFailure("retryable", "image_planner_network", "Image planner is temporarily unavailable") };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: plannerAuthFailed() };
  }
  if (response.status === 429) {
    return { ok: false, error: plannerRateLimited() };
  }
  if (isRetryableHttpStatus(response.status) || !response.ok) {
    return { ok: false, error: plannerRetryable() };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, error: plannerSchemaInvalid(), invalidContent: String(raw) };
  }

  const content = (raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, error: plannerSchemaInvalid(), invalidContent: content };
  }

  try {
    const parsed = JSON.parse(content);
    const prompts = parsed.prompts as PlannedImagePromptV1[];
    if (!Array.isArray(prompts)) {
      return { ok: false, error: plannerSchemaInvalid(), invalidContent: content };
    }

    // Extract mandatory facts from product facts title for validation
    const mandatoryFacts: string[] = [];
    if (input.productFacts && typeof input.productFacts === "object") {
      const pf = input.productFacts as Record<string, unknown>;
      if (typeof pf.title === "string" && pf.title) mandatoryFacts.push(pf.title);
      if (typeof pf.category === "string" && pf.category) mandatoryFacts.push(pf.category);
    }

    validatePlannedPrompts({
      requestedCount: input.requestedOutputCount,
      mandatoryFacts,
      prompts
    });

    return { ok: true, value: Object.freeze({ prompts }) };
  } catch {
    return { ok: false, error: plannerSchemaInvalid(), invalidContent: content };
  }
}

async function makeRepairCall(
  input: Parameters<ImagePromptPlannerPort["plan"]>[0],
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
  signal: AbortSignal,
  invalidContent: string | undefined
): Promise<{ ok: true; value: { prompts: PlannedImagePromptV1[] } } | { ok: false; error: ReturnType<typeof externalFailure> }> {
  // Repair call: only send safe validation code and the invalid JSON - no credentials or binary images
  const safePrompt = `The previous response was invalid JSON. Return the corrected plan with exactly ${input.requestedOutputCount} prompts. Schema: { prompts: [{ slot: number, role: string, prompt: string, mustPreserve: string[], forbidden: string[] }] }. Invalid response to repair: ${invalidContent ?? "unknown"}`;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
        "idempotency-key": `${input.idempotencyKey}:repair`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [{ role: "user", content: safePrompt }],
        response_format: { type: "json_schema", json_schema: { name: "image_plan_repair", strict: true, schema: planSchema } }
      })
    });
  } catch {
    return { ok: false, error: plannerTimeout() };
  }

  if (!response.ok) {
    return { ok: false, error: plannerRetryable() };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, error: plannerSchemaInvalid() };
  }

  const content = (raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, error: plannerSchemaInvalid() };
  }

  try {
    const parsed = JSON.parse(content);
    const prompts = parsed.prompts as PlannedImagePromptV1[];
    if (!Array.isArray(prompts)) {
      return { ok: false, error: plannerSchemaInvalid() };
    }

    const mandatoryFacts: string[] = [];
    if (input.productFacts && typeof input.productFacts === "object") {
      const pf = input.productFacts as Record<string, unknown>;
      if (typeof pf.title === "string" && pf.title) mandatoryFacts.push(pf.title);
      if (typeof pf.category === "string" && pf.category) mandatoryFacts.push(pf.category);
    }

    validatePlannedPrompts({
      requestedCount: input.requestedOutputCount,
      mandatoryFacts,
      prompts
    });

    return { ok: true, value: Object.freeze({ prompts }) };
  } catch {
    return { ok: false, error: plannerSchemaInvalid() };
  }
}

function buildPromptText(input: Parameters<ImagePromptPlannerPort["plan"]>[0]): string {
  const lines = [
    `Generate ${input.requestedOutputCount} image prompt(s) for a product.`,
    `Input count: ${input.recipe.inputCount}.`,
    `Output count: ${input.requestedOutputCount}.`,
    `Roles available: ${input.recipe.roles.join(", ")}.`,
    "",
    `Product facts: ${JSON.stringify(input.productFacts)}.`,
    "",
    `Return JSON with prompts array, each having: slot (1-${input.requestedOutputCount}), role, prompt (max 4000 chars), mustPreserve (facts from product to include), forbidden (prohibited phrases).`
  ];
  return lines.join("\n");
}

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompts"],
  properties: {
    prompts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "role", "prompt", "mustPreserve", "forbidden"],
        properties: {
          slot: { type: "integer", minimum: 1 },
          role: { type: "string" },
          prompt: { type: "string", maxLength: 4000 },
          mustPreserve: { type: "array", items: { type: "string" } },
          forbidden: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
} as const;

function validatePlannedPrompts(input: {
  requestedCount: number;
  mandatoryFacts: string[];
  prompts: Array<{ slot: number; role: string; prompt: string; mustPreserve: string[]; forbidden: string[] }>;
}) {
  const { requestedCount, mandatoryFacts, prompts } = input;

  if (prompts.length !== requestedCount) {
    throw new Error("image_plan_slots_invalid");
  }

  const slots = prompts.map((p) => p.slot);
  const sortedUnique = [...new Set(slots)].sort((a, b) => a - b);
  if (sortedUnique.length !== requestedCount || sortedUnique[0] !== 1 || sortedUnique[sortedUnique.length - 1] !== requestedCount) {
    throw new Error("image_plan_slots_invalid");
  }

  const slotCount: Record<number, number> = {};
  for (const s of slots) {
    slotCount[s] = (slotCount[s] ?? 0) + 1;
    if (slotCount[s] > 1) throw new Error("image_plan_slots_invalid");
  }

  for (const p of prompts) {
    if (!p.prompt || p.prompt.trim().length === 0) throw new Error("image_plan_prompt_empty");
    if (p.prompt.length > 4000) throw new Error("image_plan_prompt_too_long");

    for (const fact of mandatoryFacts) {
      if (!p.mustPreserve.includes(fact) && !p.prompt.includes(fact)) {
        throw new Error("image_plan_fact_missing");
      }
    }

    for (const phrase of p.forbidden) {
      if (p.prompt.includes(phrase)) throw new Error("image_plan_forbidden_phrase");
    }
  }

  return Object.freeze(prompts);
}
