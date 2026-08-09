import type { AppConfig } from "../../../../packages/config/src/env.js";
import { resolveRuntimeAppConfig } from "../../../../packages/config/src/env.js";
import type { RuntimeSecretsV1 } from "../../../../packages/contracts/src/runtime-configuration.js";
import type { ImagePromptPlannerPort } from "@tk/contracts/ports";
import type { RuntimeConfigurationCandidate } from "../../../../packages/db/src/repositories/runtime-configuration-repository.js";

export type ImagePromptPlannerCommandContext = Readonly<{
  kind: "worker_command";
  commandId: string;
  idempotencyKey: string;
}>;

type AdapterInput = AppConfig & Readonly<{ processKind: "app" }>;
type AdapterCreator = (
  config: AdapterInput,
  context: ImagePromptPlannerCommandContext
) => Readonly<{ imagePlanner: ImagePromptPlannerPort }> | Promise<Readonly<{ imagePlanner: ImagePromptPlannerPort }>>;

export type ImagePromptPlannerLoader = (
  context: ImagePromptPlannerCommandContext
) => Promise<ImagePromptPlannerPort>;

function runtimeUnavailable(): Error {
  return new Error("runtime_configuration_unavailable");
}

export function createImagePromptPlannerLoader(input: Readonly<{
  bootstrapConfig: AppConfig | (() => AppConfig);
  loadAppliedCandidate: () => Promise<RuntimeConfigurationCandidate | undefined>;
  openSecrets?: (candidate: RuntimeConfigurationCandidate) => RuntimeSecretsV1;
  createAdapters?: AdapterCreator;
}>): ImagePromptPlannerLoader {
  return async (context) => {
    const bootstrapConfig = typeof input.bootstrapConfig === "function"
      ? input.bootstrapConfig()
      : input.bootstrapConfig;
    const applied = await input.loadAppliedCandidate();
    if (!applied || !input.openSecrets) throw runtimeUnavailable();

    let resolved: AppConfig;
    try {
      resolved = resolveRuntimeAppConfig(
        bootstrapConfig,
        applied.publicConfig,
        input.openSecrets(applied),
        applied.runtimeConfig
      );
    } catch {
      throw runtimeUnavailable();
    }

    if (
      resolved.externalAdapterMode !== "live" ||
      resolved.imageGenerationPath !== "headless" ||
      !resolved.imageGenerationConfigured
    ) throw runtimeUnavailable();

    try {
      const createAdapters = input.createAdapters ?? (async (config, commandContext) => {
        const { createAdapterBundle } = await import("@tk/adapters");
        return createAdapterBundle(config, commandContext);
      });
      const bundle = await createAdapters({ ...resolved, processKind: "app" }, context);
      return bundle.imagePlanner;
    } catch (error) {
      if (error instanceof Error && error.message === "runtime_configuration_unavailable") throw error;
      throw runtimeUnavailable();
    }
  };
}
