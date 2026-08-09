import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import type { ImageGenerationTemplateService } from "../../../../../../server/services/image-generation-template-service";
import type { ImagePromptPlannerPort } from "@tk/contracts/ports";
import { idempotencyKey } from "@tk/contracts/ids";

const PromptTestBody = z.strictObject({
  productId: z.string().trim().min(1),
  outputCount: z.number().int().min(1).max(8),
  version: z.number().int().positive()
});

// Extend ServerServices to include imagePromptPlanner
declare module "../../../../../../server/composition" {
  interface ServerServices {
    imagePromptPlanner?: ImagePromptPlannerPort;
  }
}

// Get the planner from the adapter bundle
async function getPlanner(): Promise<ImagePromptPlannerPort> {
  const { createAdapterBundle } = await import("@tk/adapters");
  const { loadConfig } = await import("@tk/config");
  const config = loadConfig();
  const bundle = createAdapterBundle({
    externalAdapterMode: config.externalAdapterMode ?? "mock",
    nodeEnv: process.env.NODE_ENV ?? "development",
    assetRoot: config.assetRoot ?? "/tmp",
    processKind: "app"
  });
  return bundle.imagePlanner;
}

export function createPostHandler(dependencies: {
  service: ImageGenerationTemplateService;
  planner?: ImagePromptPlannerPort;
  recordAuditEvent: (event: {
    type: string;
    templateId: string;
    productId: string;
    outputCount: number;
    promptsCount: number;
  }) => void;
}) {
  return async function post(
    request: Request,
    { params }: { params: Promise<{ templateId: string }> }
  ): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;

    const { templateId } = await params;
    const parsed = PromptTestBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }

    const { productId, outputCount, version } = parsed.data;

    // Load the template's active version
    const { items } = await dependencies.service.list();
    const template = items.find((t) => t.templateId === templateId && t.version === version);
    if (!template) {
      return Response.json({ error: "template_not_found" }, { status: 404 });
    }

    // Get planner from dependencies or create one
    const planner = dependencies.planner ?? await getPlanner();

    // Call the planner (prompt-only, no batch/slot writes)
    const plannerResult = await planner.plan({
      productFacts: { productId },
      references: [],
      recipe: {
        version: 1,
        inputCount: template.recipe.inputCounts.default,
        outputCount,
        mustPreserve: [...template.recipe.mustPreserve],
        visualDirection: template.recipe.visualDirection,
        forbidden: [...template.recipe.forbidden],
        roles: template.recipe.roles.map((role) => ({
          key: role.key,
          instruction: role.instruction
        })),
        providerParameters: {}
      },
      requestedOutputCount: outputCount,
      idempotencyKey: idempotencyKey(`prompt-test-${templateId}-${Date.now()}`)
    });

    // Record redacted audit event (no batch/slot writes)
    dependencies.recordAuditEvent({
      type: "prompt_test",
      templateId,
      productId,
      outputCount,
      promptsCount: plannerResult.prompts.length
    });

    return Response.json({ prompts: plannerResult.prompts });
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ templateId: string }> }
): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  const services = await getServerServices();
  return createPostHandler({
    service: services.imageGenerationTemplates,
    planner: services.imagePromptPlanner,
    recordAuditEvent: (event) => {
      // TODO: inject real audit logger
      console.log("[audit] prompt_test", event);
    }
  })(request, { params });
}
