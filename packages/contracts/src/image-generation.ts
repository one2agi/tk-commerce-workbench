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

export type ImageGenerationRecipeV1 = Readonly<{
  version: 1;
  inputCount: number;
  outputCount: number;
  roles: string[];
}>;

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
    localImagePaths: string[];
    recipe: ImageGenerationRecipeV1;
    requestedOutputCount: number;
    idempotencyKey: IdempotencyKey;
  }>): Promise<{ prompts: PlannedImagePromptV1[] }>;
}

export interface ImageGenerationPort {
  submit(input: Readonly<{
    prompt: PlannedImagePromptV1;
    referenceImagePaths: string[];
    parameters: Record<string, unknown>;
    idempotencyKey: IdempotencyKey;
  }>): Promise<{ kind: "completed"; outputUrl: string } | { kind: "accepted"; remoteTaskId: string }>;
  fetch(input: Readonly<{ remoteTaskId: string }>): Promise<
    { state: "pending" } | { state: "succeeded"; outputUrl: string } | { state: "failed"; failure: ExternalFailure }
  >;
}
