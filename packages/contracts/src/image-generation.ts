// Headless image-generation contracts: recipe, planned prompts, and slot status.
// These types are versioned and frozen; any change requires a new version bump.

import type { IdempotencyKey } from "./ids.js";
import type { ExternalFailure } from "./errors.js";

export type ImageGenerationSlotStatus =
  | "waiting_for_plan"
  | "queued"
  | "submitting"
  | "polling"
  | "archiving"
  | "succeeded"
  | "failed"
  | "excluded";

export type ImageGenerationRoleV1 = Readonly<{
  key: string;
  instruction: string;
}>;

export type FrozenImageGenerationRecipeV1 = Readonly<{
  version: 1;
  inputCount: number;
  outputCount: number;
  mustPreserve: readonly string[];
  visualDirection: string;
  forbidden: readonly string[];
  roles: readonly ImageGenerationRoleV1[];
  providerParameters: Readonly<Record<string, unknown>>;
}>;

/** @deprecated Use FrozenImageGenerationRecipeV1 for new code. */
export type ImageGenerationRecipeV1 = FrozenImageGenerationRecipeV1;

export type ResolvedImageReferenceV1 = Readonly<{
  assetId: string;
  localPath: string;
  extension: "png" | "jpg" | "jpeg";
}>;

export type ImageGenerateSlotJobPayloadV1 = Readonly<{
  version: 1;
  batchId: string;
  slotId: string;
  slotNumber: number;
  attempt: number;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${label}[${index}]`)));
}

export function parseFrozenImageGenerationRecipeV1(value: unknown): FrozenImageGenerationRecipeV1 {
  const input = record(value, "recipe");
  if (input.version !== 1) throw new Error("recipe.version must be 1");
  if (!Array.isArray(input.roles) || input.roles.length === 0 || input.roles.length > 8) {
    throw new Error("recipe.roles must contain between 1 and 8 roles");
  }
  const roles = input.roles.map((value, index) => {
    const role = record(value, `recipe.roles[${index}]`);
    return Object.freeze({
      key: nonEmptyString(role.key, `recipe.roles[${index}].key`),
      instruction: nonEmptyString(role.instruction, `recipe.roles[${index}].instruction`)
    });
  });
  const providerParameters = record(input.providerParameters, "recipe.providerParameters");

  return Object.freeze({
    version: 1,
    inputCount: integerInRange(input.inputCount, "recipe.inputCount", 1, 6),
    outputCount: integerInRange(input.outputCount, "recipe.outputCount", 1, 8),
    mustPreserve: stringList(input.mustPreserve, "recipe.mustPreserve"),
    visualDirection: nonEmptyString(input.visualDirection, "recipe.visualDirection"),
    forbidden: stringList(input.forbidden, "recipe.forbidden"),
    roles: Object.freeze(roles),
    providerParameters: Object.freeze({ ...providerParameters })
  });
}

export function parseImageGenerateSlotJobPayload(value: unknown): ImageGenerateSlotJobPayloadV1 {
  const input = record(value, "image_generate_slot payload");
  if (input.version !== 1) throw new Error("version must be 1");
  const attempt = Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("attempt must be a non-negative integer");
  }
  return Object.freeze({
    version: 1,
    batchId: nonEmptyString(input.batchId, "batchId"),
    slotId: nonEmptyString(input.slotId, "slotId"),
    slotNumber: integerInRange(input.slotNumber, "slotNumber", 1, 8),
    attempt
  });
}

export type PlannedImagePromptV1 = Readonly<{
  slot: number;
  role: string;
  prompt: string;
  mustPreserve: string[];
  forbidden: string[];
}>;

export interface ImagePromptPlannerPort {
  plan(input: Readonly<{
    productFacts: Record<string, unknown>;
    references: readonly ResolvedImageReferenceV1[];
    recipe: FrozenImageGenerationRecipeV1;
    requestedOutputCount: number;
    idempotencyKey: IdempotencyKey;
  }>): Promise<{ prompts: PlannedImagePromptV1[] }>;
}

export interface ImageGenerationPort {
  submit(input: Readonly<{
    prompt: PlannedImagePromptV1;
    references: readonly ResolvedImageReferenceV1[];
    parameters: Readonly<Record<string, unknown>>;
    idempotencyKey: IdempotencyKey;
  }>): Promise<{ kind: "completed"; outputUrl: string } | { kind: "accepted"; remoteTaskId: string }>;
  fetch(input: Readonly<{ remoteTaskId: string }>): Promise<
    { state: "pending" } | { state: "succeeded"; outputUrl: string } | { state: "failed"; failure: ExternalFailure }
  >;
}
