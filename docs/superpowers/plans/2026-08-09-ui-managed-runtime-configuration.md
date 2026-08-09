# UI-managed Runtime Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all operator-managed provider configuration into the desktop settings UI, encrypt secrets in PostgreSQL, and make the Worker apply valid saved versions without a container restart.

**Architecture:** Shared contracts define the safe public configuration and secret mutations; `@tk/config` owns AES-256-GCM sealing. The existing singleton settings row stores public service values and one encrypted secret envelope, while a small status table reports the Worker-applied version. The Worker rebuilds its application between processing cycles when the version changes and keeps its last valid application after a rejected update.

**Tech Stack:** TypeScript 5.9, Node.js 22 crypto, Next.js 16 App Router, React 19, PostgreSQL, Vitest, Testing Library, Playwright, native CSS.

## Global Constraints

- Only `DATABASE_URL`, `TEST_DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`, process/network controls, Docker ports and volume mounts remain deployment configuration.
- `CONFIG_ENCRYPTION_KEY` is exactly 32 bytes encoded as base64; secret payloads use AES-256-GCM with a fresh 12-byte nonce.
- GET responses, logs, error payloads and audit records never contain secret plaintext, masked suffixes, ciphertext or provider response bodies.
- Existing provider environment variables seed the first database record once; PostgreSQL is authoritative afterwards.
- The Worker swaps configuration only between processing cycles; already leased jobs finish on their original snapshot.
- A rejected version does not replace the last valid runtime.
- UI stays desktop-first, native CSS, flat sections, 8px spacing, visible focus and 100-200ms restrained transitions.
- Preserve unrelated dirty files `apps/web/src/components/products/product-workbench.tsx` and `e2e/browser-workbench.spec.ts`.

---

### Task 1: Shared runtime-configuration contracts and authenticated secret codec

**Files:**
- Create: `packages/contracts/src/runtime-configuration.ts`
- Create: `packages/contracts/src/runtime-configuration.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/config/src/runtime-secrets.ts`
- Create: `packages/config/src/runtime-secrets.test.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `PublicServiceConfigurationV1`, `RuntimeSecretsV1`, `SecretFieldName`, `SecretMutation`, `SecretStatusMap`, `EncryptedSecretEnvelopeV1`.
- Produces: `createRuntimeSecretCodec(masterKeyBase64)` with `seal(secrets, recordId)` and `open(envelope, recordId)`.
- Produces: bootstrap `AppConfig.configEncryptionKey` while retaining legacy provider values only for initial seeding.

- [ ] **Step 1: Write failing contract and crypto tests**

```ts
it("round-trips secrets without exposing plaintext in the envelope", () => {
  const codec = createRuntimeSecretCodec(Buffer.alloc(32, 7).toString("base64"));
  const envelope = codec.seal({ imageProviderApiKey: "provider-secret" }, "workspace_settings:1");
  expect(JSON.stringify(envelope)).not.toContain("provider-secret");
  expect(codec.open(envelope, "workspace_settings:1")).toEqual({ imageProviderApiKey: "provider-secret" });
});

it("rejects tampering and a malformed master key", () => {
  expect(() => createRuntimeSecretCodec("short")).toThrow("config: CONFIG_ENCRYPTION_KEY must decode to 32 bytes");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @tk/contracts exec vitest run src/runtime-configuration.test.ts && pnpm --filter @tk/config exec vitest run src/runtime-secrets.test.ts src/env.test.ts`

Expected: FAIL because the types, codec and `configEncryptionKey` do not exist.

- [ ] **Step 3: Add exact shared types**

```ts
export type PublicServiceConfigurationV1 = Readonly<{
  imageGenerationPath: "headless" | "canvas";
  imagePlannerBaseUrl: string; imagePlannerModel: string;
  imageProviderBaseUrl: string; imageProviderModel: string;
  canvasBaseUrl: string; canvasId: string; canvasWorkflowName: string;
  llmBaseUrl: string; llmModel: string; exchangeRateBaseUrl: string;
  miaoshouBaseUrl: string; miaoshouAccountId: string;
  assetPublishS3Endpoint: string; assetPublishS3Region: string;
  assetPublishS3Bucket: string; assetPublishPublicBaseUrl: string;
}>;

export const SECRET_FIELD_NAMES = [
  "imagePlannerApiKey", "imageProviderApiKey", "canvasApiKey", "llmApiKey",
  "miaoshouAppKey", "miaoshouAppSecret", "miaoshouAuthorization", "miaoshouCookie",
  "assetPublishS3AccessKeyId", "assetPublishS3SecretAccessKey", "extensionToken"
] as const;
export type SecretFieldName = typeof SECRET_FIELD_NAMES[number];
export type RuntimeSecretsV1 = Readonly<Partial<Record<SecretFieldName, string>>>;
export type SecretMutation = Readonly<{ action: "replace"; value: string } | { action: "clear" }>;
export type SecretStatusMap = Readonly<Record<SecretFieldName, boolean>>;
export type EncryptedSecretEnvelopeV1 = Readonly<{ version: 1; nonce: string; tag: string; ciphertext: string }>;
```

- [ ] **Step 4: Implement AES-256-GCM and strict master-key parsing**

```ts
export function createRuntimeSecretCodec(masterKeyBase64: string) {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.byteLength !== 32) throw new Error("config: CONFIG_ENCRYPTION_KEY must decode to 32 bytes");
  return {
    seal(secrets: RuntimeSecretsV1, recordId: string): EncryptedSecretEnvelopeV1,
    open(envelope: EncryptedSecretEnvelopeV1, recordId: string): RuntimeSecretsV1
  };
}
```

Use `createCipheriv("aes-256-gcm", key, randomBytes(12))`, authenticate `runtime-config:v1:${recordId}`, and map every decryption failure to `runtime configuration secrets could not be decrypted` without including values.

- [ ] **Step 5: Add `CONFIG_ENCRYPTION_KEY` to bootstrap config and rerun tests**

Run: `pnpm --filter @tk/contracts test && pnpm --filter @tk/config test && pnpm --filter @tk/contracts typecheck && pnpm --filter @tk/config typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/contracts packages/config
git commit -m "feat(config): add encrypted runtime configuration contracts"
```

---

### Task 2: PostgreSQL persistence, legacy seeding and Worker apply status

**Files:**
- Modify: `packages/db/src/migrations/0000_initial.ts`
- Modify: `packages/db/drizzle/0000_initial.sql`
- Create: `packages/db/src/repositories/runtime-configuration-repository.ts`
- Create: `packages/db/src/repositories/runtime-configuration-repository.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`

**Interfaces:**
- Consumes: shared public configuration and encrypted-envelope types from Task 1.
- Produces: `RuntimeConfigurationRepository.loadCandidate()`, `seedIfMissing()`, `markApplied()`, `markRejected()` and `loadApplyStatus()`.

- [ ] **Step 1: Write failing repository integration tests**

```ts
it("seeds once and returns the saved candidate version", async () => {
  const repository = new RuntimeConfigurationRepository(pool);
  await repository.seedIfMissing({ publicConfig, encryptedSecrets: envelope });
  await repository.seedIfMissing({ publicConfig: otherConfig, encryptedSecrets: otherEnvelope });
  expect(await repository.loadCandidate()).toMatchObject({ version: 1, publicConfig });
});

it("records a safe rejected version without replacing applied version", async () => {
  await repository.markApplied(3);
  await repository.markRejected(4, "image_provider_required");
  expect(await repository.loadApplyStatus()).toEqual(expect.objectContaining({ appliedVersion: 3, candidateVersion: 4, state: "error", errorCode: "image_provider_required" }));
});
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `pnpm --filter @tk/db exec vitest run --config vitest.integration.config.ts src/integration/repositories.integration.test.ts`

Expected: FAIL because columns/table/repository are missing.

- [ ] **Step 3: Extend the idempotent schema**

```sql
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS service_configuration JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS encrypted_secrets JSONB;

CREATE TABLE IF NOT EXISTS runtime_configuration_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  applied_version BIGINT,
  candidate_version BIGINT,
  state TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Implement repository decoding and status upserts**

```ts
export type RuntimeConfigurationCandidate = Readonly<{
  version: number;
  publicConfig: PublicServiceConfigurationV1;
  encryptedSecrets: EncryptedSecretEnvelopeV1;
}>;

export class RuntimeConfigurationRepository {
  constructor(private readonly pool: DbPool) {}
  seedIfMissing(input: Omit<RuntimeConfigurationCandidate, "version">): Promise<void>;
  loadCandidate(): Promise<RuntimeConfigurationCandidate | undefined>;
  markApplied(version: number): Promise<void>;
  markRejected(version: number, errorCode: string): Promise<void>;
  loadApplyStatus(): Promise<RuntimeConfigurationApplyStatus>;
}
```

Use `UPDATE workspace_settings ... WHERE id = 1 AND encrypted_secrets IS NULL` so concurrent web/Worker seed attempts cannot overwrite each other.

- [ ] **Step 5: Regenerate SQL mirror and run DB verification**

Run: `pnpm db:generate && pnpm --filter @tk/db test && pnpm --filter @tk/db test:integration && pnpm --filter @tk/db typecheck`

Expected: PASS and `packages/db/drizzle/0000_initial.sql` matches `INITIAL_SQL`.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/db
git commit -m "feat(db): persist encrypted runtime configuration"
```

---

### Task 3: Settings service and safe API mutations

**Files:**
- Modify: `apps/web/src/server/services/settings-service.ts`
- Modify: `apps/web/src/server/services/settings-service.test.ts`
- Modify: `apps/web/src/app/api/v1/settings/route.ts`
- Modify: `apps/web/src/app/api/v1/settings/route.test.ts`
- Modify: `apps/web/src/server/composition.ts`
- Modify: `packages/contracts/src/read-models.ts`

**Interfaces:**
- Consumes: crypto codec, runtime repository and contract types from Tasks 1-2.
- Produces: `WorkspaceSettingsView.serviceConfiguration`, `secretStatus`, `runtimeStatus.savedVersion`, `runtimeStatus.appliedVersion`, and PATCH `secretMutations`.

- [ ] **Step 1: Write failing service/API tests for non-disclosure and mutations**

```ts
it("retains omitted secrets, replaces requested secrets and never returns plaintext", async () => {
  const updated = await service.update({ expectedVersion: 1, secretMutations: { imageProviderApiKey: { action: "replace", value: "new-secret" } } });
  expect(updated.secretStatus.imageProviderApiKey).toBe(true);
  expect(JSON.stringify(updated)).not.toContain("new-secret");
});

it("returns 400 when clearing a credential required by active headless live mode", async () => {
  const response = await patch(requestWith({ secretMutations: { imageProviderApiKey: { action: "clear" } } }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "image_provider_api_key_required", field: "imageProviderApiKey" });
});
```

- [ ] **Step 2: Run focused web tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run src/server/services/settings-service.test.ts src/app/api/v1/settings/route.test.ts`

Expected: FAIL because service configuration and secret mutations are unsupported.

- [ ] **Step 3: Extend settings records and optimistic update**

Add `serviceConfiguration` and internal `encryptedSecrets` to `WorkspaceSettingsRecord`; keep `encryptedSecrets` out of `WorkspaceSettingsView`. Update the singleton row with one SQL statement guarded by `WHERE id = 1 AND version = $expectedVersion`, so public fields and ciphertext commit atomically.

- [ ] **Step 4: Apply explicit secret mutations and validate active groups**

```ts
function applySecretMutations(current: RuntimeSecretsV1, mutations: Partial<Record<SecretFieldName, SecretMutation>>): RuntimeSecretsV1 {
  const next = { ...current };
  for (const [field, mutation] of Object.entries(mutations)) {
    if (mutation.action === "clear") delete next[field as SecretFieldName];
    else next[field as SecretFieldName] = mutation.value.trim();
  }
  return next;
}
```

Validate complete Headless, Canvas, Miaoshou and S3 groups only when live mode and the relevant feature is active. Return stable `{ error, field }` responses, never exception strings.

- [ ] **Step 5: Make GET return safe configuration and apply status**

Return booleans generated from decrypted key presence plus repository status. Preserve existing 409 behavior and existing pricing/retry fields.

- [ ] **Step 6: Run web service/API tests and typecheck**

Run: `pnpm --filter @tk/web exec vitest run src/server/services/settings-service.test.ts src/app/api/v1/settings/route.test.ts src/components/settings/__tests__/settings-api.test.tsx && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/web/src/server packages/contracts/src/read-models.ts apps/web/src/app/api/v1/settings
git commit -m "feat(settings): manage encrypted provider configuration"
```

---

### Task 4: Dynamic browser-extension token verification

**Files:**
- Modify: `apps/web/src/server/auth/extension-token.ts`
- Modify: `apps/web/src/server/auth/extension-token.test.ts`
- Modify: `apps/web/src/server/composition.ts`
- Modify: `apps/web/src/app/api/v1/local-captures/route.test.ts`
- Modify: `apps/web/src/app/api/v1/ingest-links/route.test.ts`

**Interfaces:**
- Consumes: a `() => Promise<string>` token loader backed by current encrypted settings.
- Produces: `createDynamicExtensionTokenVerifier(loadToken)`.

- [ ] **Step 1: Write failing token-rotation test**

```ts
it("uses the latest stored token without rebuilding server services", async () => {
  let token = "first-token";
  const verify = createDynamicExtensionTokenVerifier(async () => token);
  await expect(verify("Bearer first-token")).resolves.toBe(true);
  token = "second-token";
  await expect(verify("Bearer first-token")).resolves.toBe(false);
  await expect(verify("Bearer second-token")).resolves.toBe(true);
});
```

- [ ] **Step 2: Run auth tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run src/server/auth/extension-token.test.ts`

Expected: FAIL because the dynamic verifier does not exist.

- [ ] **Step 3: Implement per-request safe token loading**

Hash the loaded token and candidate with SHA-256 and compare with `timingSafeEqual`. The loader returns the decrypted token only inside the server process; do not cache it in the browser or response.

- [ ] **Step 4: Wire routes through the dynamic verifier and run tests**

Run: `pnpm --filter @tk/web exec vitest run src/server/auth/extension-token.test.ts src/app/api/v1/local-captures/route.test.ts src/app/api/v1/ingest-links/route.test.ts && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/web/src/server/auth apps/web/src/server/composition.ts apps/web/src/app/api/v1/local-captures apps/web/src/app/api/v1/ingest-links
git commit -m "feat(extension): apply token changes without restart"
```

---

### Task 5: Last-known-good Worker hot reload

**Files:**
- Create: `apps/worker/src/runtime/reloadable-worker-application.ts`
- Create: `apps/worker/src/runtime/reloadable-worker-application.test.ts`
- Modify: `apps/worker/src/entry.ts`
- Modify: `apps/worker/src/entry.test.ts`
- Modify: `apps/worker/src/cli.ts`
- Modify: `apps/worker/src/cli.test.ts`
- Modify: `packages/config/src/env.ts`

**Interfaces:**
- Consumes: `RuntimeConfigurationRepository`, secret codec and `createWorkerApplication({ resolvedConfig })`.
- Produces: `createReloadableWorkerApplication({ loadCandidate, build, markApplied, markRejected })` implementing `WorkerApplication`.

- [ ] **Step 1: Write failing hot-reload tests**

```ts
it("applies a newer valid version before the next processing cycle", async () => {
  candidate = { version: 2, config: secondConfig };
  await application.run({ maxJobs: 1 });
  expect(build).toHaveBeenLastCalledWith(candidate);
  expect(markApplied).toHaveBeenCalledWith(2);
  expect(second.run).toHaveBeenCalled();
});

it("keeps the last valid application when candidate construction fails", async () => {
  candidate = { version: 3, config: invalidConfig };
  build.mockRejectedValueOnce(Object.assign(new Error("hidden"), { code: "image_provider_required" }));
  await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 0 });
  expect(first.run).toHaveBeenCalledTimes(2);
  expect(markRejected).toHaveBeenCalledWith(3, "image_provider_required");
});
```

- [ ] **Step 2: Run Worker tests and verify RED**

Run: `pnpm --filter @tk/worker exec vitest run src/runtime/reloadable-worker-application.test.ts src/entry.test.ts src/cli.test.ts`

Expected: FAIL because reloadable application and resolved configuration injection are absent.

- [ ] **Step 3: Implement the reload wrapper**

```ts
export interface ReloadableWorkerApplicationInput {
  loadCandidate(): Promise<ResolvedRuntimeCandidate>;
  build(candidate: ResolvedRuntimeCandidate): Promise<WorkerApplication>;
  markApplied(version: number): Promise<void>;
  markRejected(version: number, errorCode: string): Promise<void>;
}
```

Check before every `run()` cycle. Build first, atomically replace the current reference, mark applied, then close the previous application. When build fails and a current application exists, record a safe code and continue with current. Initial build failure remains fatal.

- [ ] **Step 4: Resolve database values into `AppConfig`**

Add a pure `resolveRuntimeAppConfig(bootstrap, publicConfig, secrets)` that maps stored fields to the existing adapter factory shape and recomputes all `*Configured` booleans. Database URLs, asset root, operator ID, lease timing, environment and master key remain from bootstrap.

- [ ] **Step 5: Wire CLI to the reloadable application**

Create one lightweight status/config pool owned by the wrapper. `createWorkerApplication` accepts a resolved config and continues to own one generation's adapter and job pool. `close()` closes both the current generation and loader pool exactly once.

- [ ] **Step 6: Run Worker unit, integration and type tests**

Run: `pnpm --filter @tk/worker test && pnpm --filter @tk/worker test:integration && pnpm --filter @tk/worker typecheck`

Expected: PASS, including existing recovery/idempotency tests.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/worker packages/config/src/env.ts packages/config/src/env.test.ts
git commit -m "feat(worker): hot-reload saved runtime configuration"
```

---

### Task 6: Distilled and hardened desktop settings UI

**Files:**
- Modify: `apps/web/src/components/settings/settings-workspace.tsx`
- Modify: `apps/web/src/components/settings/settings-api.ts`
- Modify: `apps/web/src/components/settings/dirty.ts`
- Modify: `apps/web/src/components/settings/sections/provider-options-section.tsx`
- Replace: `apps/web/src/components/settings/sections/secret-status-section.tsx`
- Create: `apps/web/src/components/settings/sections/external-services-section.tsx`
- Create: `apps/web/src/components/settings/secret-field.tsx`
- Modify: `apps/web/src/components/settings/save-bar.tsx`
- Modify: `apps/web/src/app/globals.css`
- Test: `apps/web/src/components/settings/__tests__/sections.test.tsx`
- Test: `apps/web/src/components/settings/__tests__/settings-workspace.test.tsx`
- Test: `apps/web/src/components/settings/__tests__/settings-api.test.tsx`
- Test: `apps/web/src/components/settings/__tests__/dirty.test.ts`

**Interfaces:**
- Consumes: safe view and `secretMutations` PATCH contract from Task 3.
- Produces: controlled public fields and local `SecretDraft = { value: string; clear: boolean }` state; secrets never enter `WorkspaceSettingsView`.

- [ ] **Step 1: Write failing UI behavior tests**

```tsx
it("shows only the selected image route and keeps a configured secret by default", async () => {
  render(<SettingsWorkspace initial={headlessSettings()} fetcher={fetcher} />);
  expect(screen.getByLabelText("Planner 服务地址")).toBeVisible();
  expect(screen.queryByLabelText("Canvas 地址")).toBeNull();
  expect(screen.getByText("Planner API Key 已配置")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "保存并应用" }));
  expect(JSON.parse(fetcher.mock.calls[0][1].body).secretMutations).toEqual({});
});

it("sends an explicit clear mutation only after inline confirmation", async () => {
  await user.click(screen.getByRole("button", { name: "清除 Planner API Key" }));
  await user.click(screen.getByRole("button", { name: "确认清除 Planner API Key" }));
  expect(patchBody.secretMutations.imagePlannerApiKey).toEqual({ action: "clear" });
});
```

- [ ] **Step 2: Run settings jsdom tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.jsdom.config.ts src/components/settings/__tests__/sections.test.tsx src/components/settings/__tests__/settings-workspace.test.tsx src/components/settings/__tests__/settings-api.test.tsx`

Expected: FAIL because service fields, secret draft state and new copy are missing.

- [ ] **Step 3: Add secret-field interaction without plaintext hydration**

```ts
export type SecretDraft = Readonly<{ value: string; clear: boolean }>;
export function toSecretMutation(draft: SecretDraft): SecretMutation | undefined {
  if (draft.clear) return { action: "clear" };
  const value = draft.value.trim();
  return value ? { action: "replace", value } : undefined;
}
```

Render an empty password input, configured status, replace help and inline two-step clear action. Do not place saved secrets in DOM attributes or React state.

- [ ] **Step 4: Restructure the settings page into four flat sections**

Keep the current sidebar. Use basic runtime, image generation, external services and reliability. Show Headless or Canvas fields conditionally. Move read-only deployment diagnostics out of editable fields. Avoid provider cards inside settings cards.

- [ ] **Step 5: Implement saved/applied feedback and safe API body**

The save hook sends public configuration plus only non-empty secret mutations, shows `正在加密并应用配置`, then renders saved version and applied/pending/error status returned by GET/PATCH. Primary copy is `保存并应用`.

- [ ] **Step 6: Apply `frontend-design-pro` `/distill` and `/harden` CSS constraints**

Use the existing Geist typography if present, an 8px spacing scale, tinted neutral colors, 2px visible focus, and `160ms cubic-bezier(0.16, 1, 0.3, 1)` transitions with `prefers-reduced-motion`. Remove obsolete nested service-status styling rather than layering more CSS over it.

- [ ] **Step 7: Run UI tests, lint and typecheck**

Run: `pnpm --filter @tk/web test && pnpm --filter @tk/web lint && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/web/src/components/settings apps/web/src/app/globals.css
git commit -m "feat(settings): add production runtime configuration UI"
```

---

### Task 7: Docker bootstrap, migration documentation and end-to-end acceptance

**Files:**
- Modify: `.env.example`
- Modify: `scripts/local-production-config.mjs`
- Modify: `scripts/tests/local-production-config.test.mjs`
- Modify: `scripts/start-local-production.mjs`
- Modify: `compose.dev.yml`
- Modify: `compose.prod.yml`
- Modify: `docker-compose.yml`
- Modify: `scripts/tests/docker-compose.test.mjs`
- Modify: `docs/operations/local-production.md`
- Modify: `docs/operations/headless-image-generation.md`
- Create: `e2e/runtime-settings-application.spec.ts`

**Interfaces:**
- Consumes: completed API, Worker reload and UI flows.
- Produces: generated `CONFIG_ENCRYPTION_KEY`, legacy first-run import and deployment instructions.

- [ ] **Step 1: Write failing bootstrap and E2E tests**

```js
assert.match(env, /^CONFIG_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$/m);
assert.equal(readCompose("compose.prod.yml").services.worker.environment.CONFIG_ENCRYPTION_KEY, "${CONFIG_ENCRYPTION_KEY}");
```

```ts
test("saved headless provider settings are applied without restarting Worker", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Planner 模型").fill("planner-v2");
  await page.getByLabel("Planner API Key").fill("test-planner-key-v2");
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.getByText(/已应用 v\d+/)).toBeVisible();
});
```

- [ ] **Step 2: Run bootstrap tests and verify RED**

Run: `node --test scripts/tests/local-production-config.test.mjs scripts/tests/docker-compose.test.mjs`

Expected: FAIL because the master key is not generated or passed through Compose.

- [ ] **Step 3: Generate and pass through the master key**

Generate `randomBytes(32).toString("base64")` only when creating a new local `.env`. Never rotate an existing value automatically. Require it in production startup checks and pass it to web and Worker services.

- [ ] **Step 4: Update migration and backup documentation**

Document that provider env values are imported once, can then be removed, and that a database backup requires the matching `CONFIG_ENCRYPTION_KEY`. Document the exact restore order: restore volumes/database, supply the same key, then start containers.

- [ ] **Step 5: Run end-to-end verification**

Run: `pnpm test:docker && pnpm test && pnpm typecheck && pnpm test:integration && pnpm exec playwright test e2e/runtime-settings-application.spec.ts e2e/headless-image-generation.spec.ts`

Expected: all commands PASS; existing data/assets remain mounted; no provider plaintext appears in captured responses or logs.

- [ ] **Step 6: Perform desktop browser acceptance**

At `http://127.0.0.1:3000/settings`, verify with Chrome DevTools MCP or agent-browser at a 1440x900 viewport:

- no horizontal overflow;
- Headless/Canvas conditional fields are correct;
- keyboard focus is visible;
- secret replace/clear behavior is explicit;
- save bar appears only when dirty;
- saved and applied versions converge without a Worker restart;
- console has no errors and settings PATCH contains no retained secret plaintext.

- [ ] **Step 7: Commit Task 7**

```bash
git add .env.example scripts compose.dev.yml compose.prod.yml docker-compose.yml docs/operations e2e/runtime-settings-application.spec.ts
git commit -m "docs(deploy): support UI-managed runtime configuration"
```

---

### Final verification and integration

- [ ] Run `git diff --check` and confirm only planned files changed plus the two preserved user-owned dirty files on `main`.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:docker` and the focused Playwright specs.
- [ ] Request an independent code review focused on secret disclosure, migration safety and last-known-good Worker behavior.
- [ ] Resolve Critical/Important findings and rerun affected commands.
- [ ] Merge the implementation branch into `main` while preserving the user's existing scroll changes.
