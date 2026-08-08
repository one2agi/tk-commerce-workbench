import { z } from "zod";

import type { SettingsService } from "../../../../server/services/settings-service";
import { SettingsConflictError } from "../../../../server/services/settings-service";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../server/auth/loopback";

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).max(30);
const SettingsUpdateBody = z.strictObject({
  expectedVersion: z.number().int().positive(),
  defaultLocale: z.string().trim().min(2).max(35).optional(),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  externalAdapterMode: z.enum(["mock", "live"]).optional(),
  workerConcurrency: z.number().int().min(1).max(32).optional(),
  maxCanvasRunsPerDay: z.number().int().min(0).max(10_000).optional(),
  assetRoot: z.string().trim().min(1).max(500).optional(),
  pricingDefaults: z.strictObject({
    domesticShippingCny: decimal,
    crossBorderCostCny: decimal,
    fixedTargetCostThb: decimal,
    platformFeeRate: decimal,
    paymentFeeRate: decimal,
    targetProfitRate: decimal,
    ending: z.string().regex(/^\d{1,2}$/)
  }).optional(),
  providerOptions: z.strictObject({
    listingProvider: z.string().trim().min(1).max(80),
    listingModel: z.string().trim().min(1).max(120),
    canvasWorkflow: z.string().trim().min(1).max(120),
    imageGenerationPath: z.enum(["headless", "canvas"]),
    imagePlannerModel: z.string().trim().max(160),
    imageProviderModel: z.string().trim().max(160)
  }).superRefine((value, context) => {
    if (value.imageGenerationPath !== "headless") return;
    if (!value.imagePlannerModel) {
      context.addIssue({ code: "custom", path: ["imagePlannerModel"], message: "Planner 模型不能为空" });
    }
    if (!value.imageProviderModel) {
      context.addIssue({ code: "custom", path: ["imageProviderModel"], message: "图片模型不能为空" });
    }
  }).optional(),
  retryPolicy: z.strictObject({
    maxAttempts: z.number().int().min(1).max(20),
    initialDelaySeconds: z.number().int().min(1).max(86_400)
  }).optional()
});

export function createGetHandler(dependencies: { service: SettingsService }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(await dependencies.service.get());
  };
}

export function createPatchHandler(dependencies: { service: SettingsService }) {
  return async function patch(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = SettingsUpdateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      return Response.json(await dependencies.service.update(parsed.data));
    } catch (error) {
      if (error instanceof SettingsConflictError || hasActualVersion(error)) {
        return Response.json({
          error: "settings_version_conflict",
          actualVersion: error.actualVersion
        }, { status: 409 });
      }
      throw error;
    }
  };
}

function hasActualVersion(error: unknown): error is { actualVersion: number } {
  return typeof error === "object" && error !== null &&
    typeof (error as { actualVersion?: unknown }).actualVersion === "number";
}

export async function GET(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createGetHandler({ service: (await getServerServices()).settings })(request);
}

export async function PATCH(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createPatchHandler({ service: (await getServerServices()).settings })(request);
}
