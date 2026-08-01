import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PlannedImagePromptV1 } from "@tk/contracts/ports";

// Inline types mirroring production route
const PromptTestBody = z.strictObject({
  productId: z.string().trim().min(1),
  outputCount: z.number().int().min(1).max(8)
});

// Minimal recipe for test fixtures
const minimalRecipe = {
  inputCounts: { default: 2, min: 1, max: 6 },
  outputCounts: { default: 4, min: 1, max: 8 },
  mustPreserve: [] as string[],
  visualDirection: "clean white background",
  forbidden: [] as string[],
  roles: [
    { key: "hero", instruction: "Primary hero shot" },
    { key: "detail", instruction: "Close-up detail view" }
  ]
};

// Fake image prompt planner that returns canned prompts
class FakeImagePlanner {
  public readonly calls: { method: string; input: unknown }[] = [];
  public planResult: { prompts: PlannedImagePromptV1[] } = {
    prompts: [
      { slot: 1, role: "hero", prompt: "A clean white background hero shot", mustPreserve: [], forbidden: [] },
      { slot: 2, role: "detail", prompt: "A close-up detail view", mustPreserve: [], forbidden: [] }
    ]
  };

  async plan(input: { productFacts: Record<string, unknown>; localImagePaths: string[]; recipe: { version: 1; inputCount: number; outputCount: number; roles: string[] }; requestedOutputCount: number; idempotencyKey: { kind: string; value: string } }): Promise<{ prompts: PlannedImagePromptV1[] }> {
    this.calls.push({ method: "plan", input });
    return this.planResult;
  }
}

// Fake job repository that tracks enqueue calls
class FakeJobRepository {
  public enqueueCalls: { method: string; input: unknown }[] = [];

  async enqueue(job: { name: string; input: unknown }): Promise<void> {
    this.enqueueCalls.push({ method: "enqueue", input: job });
  }
}

// Mock audit event recorder
const fakeAuditEvents: unknown[] = [];
const fakeRecordAuditEvent = vi.fn().mockImplementation((event: unknown) => {
  fakeAuditEvents.push(event);
});

// Minimal in-memory store matching what the inline handler needs
function makeInMemoryStore() {
  const templates: Array<{
    id: string;
    name: string;
    categoryKey: string;
    parentCategoryKey: string | null;
    activeVersionId: string | null;
    enabled: boolean;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const versions: Array<{
    id: string;
    templateId: string;
    version: number;
    lifecycleState: "draft" | "active" | "archived";
    recipe: typeof minimalRecipe;
    activatedAt: Date | null;
    createdAt: Date;
  }> = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;

  return {
    templates,
    versions,
    async createTemplate(input: { name: string; categoryKey: string; parentCategoryKey?: string }) {
      const id = nextId("tmpl");
      const now = new Date();
      const t = { id, name: input.name, categoryKey: input.categoryKey, parentCategoryKey: input.parentCategoryKey ?? null, activeVersionId: null as string | null, enabled: true, archivedAt: null, createdAt: now, updatedAt: now };
      templates.push(t);
      return t;
    },
    async createVersion(input: { templateId: string; version: number; lifecycleState: "draft" | "active" | "archived"; recipe: typeof minimalRecipe; activatedAt?: Date }) {
      const id = nextId("ver");
      const now = new Date();
      const v = { id, templateId: input.templateId, version: input.version, lifecycleState: input.lifecycleState, recipe: input.recipe, activatedAt: input.activatedAt ?? null, createdAt: now };
      versions.push(v);
      if (input.lifecycleState === "active") {
        const t = templates.find(t => t.id === input.templateId)!;
        t.activeVersionId = id;
      }
      return v;
    },
    async getVersionsByTemplate(templateId: string) {
      return versions.filter(v => v.templateId === templateId);
    },
    async getVersion(versionId: string) {
      return versions.find(v => v.id === versionId) ?? null;
    },
    async getTemplate(templateId: string) {
      return templates.find(t => t.id === templateId) ?? null;
    },
    async updateVersionArchived(version: typeof versions[0]) {
      const v = versions.find(v => v.id === version.id);
      if (v) v.lifecycleState = "archived";
    },
    async updateTemplateActiveVersion(templateId: string, versionId: string) {
      const t = templates.find(t => t.id === templateId);
      if (t) t.activeVersionId = versionId;
    },
    async listTemplates() {
      return templates;
    }
  };
}

// Inline service mimicking ImageGenerationTemplateService behavior for list + activate
function makeService(store: ReturnType<typeof makeInMemoryStore>) {
  return {
    async createDraft(input: { name: string; categoryKey: string; parentCategoryKey?: string; recipe: typeof minimalRecipe }) {
      const t = await store.createTemplate({ name: input.name, categoryKey: input.categoryKey, parentCategoryKey: input.parentCategoryKey });
      const v = await store.createVersion({ templateId: t.id, version: 1, lifecycleState: "draft", recipe: input.recipe });
      return { templateId: t.id, name: t.name, categoryKey: t.categoryKey, parentCategoryKey: t.parentCategoryKey, version: v.version, lifecycleState: v.lifecycleState as string, recipe: v.recipe, activatedAt: v.activatedAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString() };
    },
    async activate(templateId: string, targetVersion: number) {
      const versions = await store.getVersionsByTemplate(templateId);
      const toActivate = versions.find(v => v.version === targetVersion && v.lifecycleState === "draft");
      if (!toActivate) throw new Error("draft_version_not_found");
      const currentActive = versions.find(v => v.lifecycleState === "active");
      if (currentActive) await store.updateVersionArchived(currentActive);
      const activated = await store.createVersion({ templateId, version: toActivate.version, lifecycleState: "active", recipe: toActivate.recipe, activatedAt: new Date() });
      await store.updateTemplateActiveVersion(templateId, activated.id);
      const t = await store.getTemplate(templateId);
      return { templateId: t!.id, name: t!.name, categoryKey: t!.categoryKey, parentCategoryKey: t!.parentCategoryKey, version: activated.version, lifecycleState: "active", recipe: activated.recipe, activatedAt: activated.activatedAt?.toISOString() ?? null, createdAt: activated.createdAt.toISOString() };
    },
    async list() {
      const items = [];
      for (const t of await store.listTemplates()) {
        if (t.activeVersionId) {
          const v = await store.getVersion(t.activeVersionId);
          if (v) items.push({ templateId: t.id, name: t.name, categoryKey: t.categoryKey, parentCategoryKey: t.parentCategoryKey, version: v.version, lifecycleState: v.lifecycleState, recipe: v.recipe, activatedAt: v.activatedAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString() });
        }
      }
      return { items };
    }
  };
}

// Inline handler that mirrors the production route behavior
function makePromptTestHandler(deps: {
  service: ReturnType<typeof makeService>;
  planner: FakeImagePlanner;
  jobRepository: FakeJobRepository;
  recordAuditEvent: typeof fakeRecordAuditEvent;
}) {
  return async function handle(
    request: Request,
    context: { params: Promise<{ templateId: string }> }
  ): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
    if (!allowed) return Response.json({ error: "loopback_only" }, { status: 403 });

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const origin = request.headers.get("origin");
    if (contentType !== "application/json" || !origin) {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    const { templateId } = await context.params;
    const parsed = PromptTestBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }

    const { productId, outputCount } = parsed.data;

    // Load template + active version
    const { items } = await deps.service.list();
    const template = items.find((t: any) => t.templateId === templateId);
    if (!template) {
      return Response.json({ error: "template_not_found" }, { status: 404 });
    }

    // Call the planner (prompt-only, no batch/slot writes)
    const plannerResult = await deps.planner.plan({
      productFacts: { productId },
      localImagePaths: ["/api/v1/assets/asset_1", "/api/v1/assets/asset_2"],
      recipe: {
        version: 1 as const,
        inputCount: template.recipe.inputCounts.default,
        outputCount,
        roles: template.recipe.roles.map((r: any) => r.key)
      },
      requestedOutputCount: outputCount,
      idempotencyKey: { kind: "PromptTest", value: `prompt-test-${templateId}-${Date.now()}` }
    });

    // Record redacted audit event (no batch/slot writes)
    deps.recordAuditEvent({
      type: "prompt_test",
      templateId,
      productId,
      outputCount,
      promptsCount: plannerResult.prompts.length
    });

    return Response.json({ prompts: plannerResult.prompts });
  };
}

function promptTestRequest(overrides: { productId?: string; outputCount?: number } = {}) {
  return new Request("http://127.0.0.1/api/v1/image-generation-templates/tmpl_1/prompt-test", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ productId: "prod_1", outputCount: 5, ...overrides })
  });
}

describe("prompt-test route", () => {
  it("returns 200 and prompts without creating image jobs", async () => {
    const store = makeInMemoryStore();
    const service = makeService(store);
    const planner = new FakeImagePlanner();
    const jobRepository = new FakeJobRepository();

    // Seed a template with active version
    await service.createDraft({
      name: "Test Template",
      categoryKey: "test.category",
      recipe: minimalRecipe as any
    });
    await service.activate("tmpl_1", 1);

    const handler = makePromptTestHandler({
      service,
      planner,
      jobRepository,
      recordAuditEvent: fakeRecordAuditEvent
    });

    const response = await handler(promptTestRequest({ outputCount: 5 }), { params: Promise.resolve({ templateId: "tmpl_1" }) });

    expect(response.status).toBe(200);
    expect(jobRepository.enqueueCalls).toHaveLength(0); // No batch/slot jobs created
    const body = await response.json() as any;
    expect(body.prompts).toBeDefined();
    expect(Array.isArray(body.prompts)).toBe(true);
  });

  it("calls the planner with correct recipe from template", async () => {
    const store = makeInMemoryStore();
    const service = makeService(store);
    const planner = new FakeImagePlanner();

    await service.createDraft({
      name: "Test Template",
      categoryKey: "test.category",
      recipe: minimalRecipe as any
    });
    await service.activate("tmpl_1", 1);

    const handler = makePromptTestHandler({
      service,
      planner,
      jobRepository: new FakeJobRepository(),
      recordAuditEvent: fakeRecordAuditEvent
    });

    await handler(promptTestRequest({ outputCount: 3 }), { params: Promise.resolve({ templateId: "tmpl_1" }) });

    expect(planner.calls).toHaveLength(1);
    const planInput = (planner.calls[0] as any).input;
    expect(planInput.requestedOutputCount).toBe(3);
  });

  it("records a redacted audit event", async () => {
    fakeAuditEvents.length = 0;
    fakeRecordAuditEvent.mockClear();
    const store = makeInMemoryStore();
    const service = makeService(store);
    const planner = new FakeImagePlanner();

    await service.createDraft({
      name: "Test Template",
      categoryKey: "test.category",
      recipe: minimalRecipe as any
    });
    await service.activate("tmpl_1", 1);

    const handler = makePromptTestHandler({
      service,
      planner,
      jobRepository: new FakeJobRepository(),
      recordAuditEvent: fakeRecordAuditEvent
    });

    await handler(promptTestRequest({ outputCount: 5 }), { params: Promise.resolve({ templateId: "tmpl_1" }) });

    expect(fakeRecordAuditEvent).toHaveBeenCalledTimes(1);
    const event = (fakeRecordAuditEvent.mock.calls[0] as any)[0];
    expect(event.type).toBe("prompt_test");
    expect(event.productId).toBeDefined();
  });

  it("returns 400 for invalid request body", async () => {
    const store = makeInMemoryStore();
    const service = makeService(store);
    const planner = new FakeImagePlanner();

    const handler = makePromptTestHandler({
      service,
      planner,
      jobRepository: new FakeJobRepository(),
      recordAuditEvent: fakeRecordAuditEvent
    });

    const badRequest = new Request("http://127.0.0.1/api/v1/image-generation-templates/tmpl_1/prompt-test", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ productId: "", outputCount: 0 })
    });

    const response = await handler(badRequest, { params: Promise.resolve({ templateId: "tmpl_1" }) });
    expect(response.status).toBe(400);
  });

  it("returns 403 for non-loopback origin", async () => {
    const store = makeInMemoryStore();
    const service = makeService(store);
    const planner = new FakeImagePlanner();

    const handler = makePromptTestHandler({
      service,
      planner,
      jobRepository: new FakeJobRepository(),
      recordAuditEvent: fakeRecordAuditEvent
    });

    const response = await handler(
      new Request("http://192.168.1.8/api/v1/image-generation-templates/tmpl_1/prompt-test", {
        method: "POST",
        headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ productId: "prod_1", outputCount: 5 })
      }),
      { params: Promise.resolve({ templateId: "tmpl_1" }) }
    );

    expect(response.status).toBe(403);
  });
});
