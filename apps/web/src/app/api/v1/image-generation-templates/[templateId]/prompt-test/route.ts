import { randomUUID } from "node:crypto";
import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import type { ImageGenerationTemplateService } from "../../../../../../server/services/image-generation-template-service";
import type { ImagePromptPlannerPort, ResolvedImageReferenceV1 } from "@tk/contracts/ports";
import { idempotencyKey } from "@tk/contracts/ids";
import type { ImagePromptPlannerCommandContext } from "../../../../../../server/image-prompt-test-runtime";

const PromptTestBody = z.strictObject({
  productId: z.string().trim().min(1),
  outputCount: z.number().int().min(1).max(8),
  version: z.number().int().positive()
});

export function createPostHandler(dependencies: {
  service: ImageGenerationTemplateService;
  loadPlanner: (context: ImagePromptPlannerCommandContext) => Promise<ImagePromptPlannerPort>;
  loadProductContext: (productId: string) => Promise<{
    productFacts: Record<string, unknown>;
    references: ResolvedImageReferenceV1[];
  } | null>;
  recordAuditEvent: (event: {
    type: string;
    templateId: string;
    productId: string;
    outputCount: number;
    promptsCount: number;
  }) => void | Promise<void>;
  reportAuditFailure?: () => void;
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

    const productContext = await dependencies.loadProductContext(productId);
    if (!productContext) {
      return Response.json({ error: "product_not_found" }, { status: 404 });
    }

    const plannerRequestKey = idempotencyKey(
      `prompt-test:${templateId}:v${version}:${productId}:${randomUUID()}`
    );
    const commandContext: ImagePromptPlannerCommandContext = {
      kind: "worker_command",
      commandId: `prompt-test:${templateId}:v${version}`,
      idempotencyKey: plannerRequestKey
    };

    try {
      const planner = await dependencies.loadPlanner(commandContext);
      const plannerResult = await planner.plan({
        productFacts: productContext.productFacts,
        references: productContext.references,
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
        idempotencyKey: plannerRequestKey
      });

      try {
        await dependencies.recordAuditEvent({
          type: "prompt_test",
          templateId,
          productId,
          outputCount,
          promptsCount: plannerResult.prompts.length
        });
      } catch {
        // The paid planner call already succeeded. Returning its result avoids
        // encouraging an unnecessary paid retry when audit storage is down.
        dependencies.reportAuditFailure?.();
      }

      return Response.json({ prompts: plannerResult.prompts });
    } catch (error) {
      if (error instanceof Error && error.message === "runtime_configuration_unavailable") {
        return Response.json({ error: "runtime_configuration_unavailable" }, { status: 503 });
      }
      return Response.json({ error: "prompt_planner_unavailable" }, { status: 502 });
    }
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
    loadPlanner: services.loadImagePromptPlanner,
    loadProductContext: services.loadImagePromptTestContext,
    recordAuditEvent: services.recordImagePromptTestAudit,
    reportAuditFailure: () => process.emitWarning(
      "Image prompt-test audit write failed after successful planning",
      { code: "IMAGE_PROMPT_TEST_AUDIT_FAILED" }
    )
  })(request, { params });
}
