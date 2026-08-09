import { z } from "zod";

import type { SettingsService } from "../../../../server/services/settings-service";
import { SettingsConflictError, SettingsValidationError } from "../../../../server/services/settings-service";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../server/auth/loopback";

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).max(30);
const secretMutation = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("replace"), value: z.string().trim().min(1).max(20_000) }),
  z.strictObject({ action: z.literal("clear") })
]);
const SettingsUpdateBody = z.strictObject({
  expectedVersion: z.number().int().positive(),
  defaultLocale: z.string().trim().min(2).max(35).optional(),
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  externalAdapterMode: z.enum(["mock", "live"]).optional(),
  workerConcurrency: z.number().int().min(1).max(32).optional(),
  maxCanvasRunsPerDay: z.number().int().min(0).max(10_000).optional(),
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
  serviceConfiguration: z.strictObject({
    imageGenerationPath: z.enum(["headless", "canvas"]),
    imagePlannerBaseUrl: z.string().trim().max(500), imagePlannerModel: z.string().trim().max(160),
    imageProviderBaseUrl: z.string().trim().max(500), imageProviderModel: z.string().trim().max(160),
    canvasBaseUrl: z.string().trim().max(500), canvasId: z.string().trim().max(160),
    canvasWorkflowName: z.string().trim().max(160), llmBaseUrl: z.string().trim().max(500),
    llmModel: z.string().trim().max(160), exchangeRateBaseUrl: z.string().trim().max(500),
    miaoshouBaseUrl: z.string().trim().max(500), miaoshouAccountId: z.string().trim().max(160),
    assetPublishS3Endpoint: z.string().trim().max(500), assetPublishS3Region: z.string().trim().max(160),
    assetPublishS3Bucket: z.string().trim().max(160), assetPublishPublicBaseUrl: z.string().trim().max(500)
  }).optional(),
  retryPolicy: z.strictObject({
    maxAttempts: z.number().int().min(1).max(20),
    initialDelaySeconds: z.number().int().min(1).max(86_400)
  }).optional(),
  secretMutations: z.strictObject({
    imagePlannerApiKey: secretMutation.optional(), imageProviderApiKey: secretMutation.optional(),
    canvasApiKey: secretMutation.optional(), llmApiKey: secretMutation.optional(),
    miaoshouAppKey: secretMutation.optional(), miaoshouAppSecret: secretMutation.optional(),
    miaoshouAuthorization: secretMutation.optional(), miaoshouCookie: secretMutation.optional(),
    assetPublishS3AccessKeyId: secretMutation.optional(), assetPublishS3SecretAccessKey: secretMutation.optional(),
    extensionToken: secretMutation.optional()
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
      if (error instanceof SettingsValidationError) {
        return Response.json({ error: error.code, field: error.field }, { status: 400 });
      }
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
