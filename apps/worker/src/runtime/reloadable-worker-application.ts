import type { AppConfig } from "@tk/config";

import type { WorkerApplication } from "../entry.js";

export type ResolvedRuntimeCandidate = Readonly<{
  version: number;
  config: AppConfig;
}>;

export interface ReloadableWorkerApplicationInput {
  loadAppliedCandidate?(): Promise<ResolvedRuntimeCandidate | undefined>;
  loadCandidate(): Promise<ResolvedRuntimeCandidate | undefined>;
  build(candidate: ResolvedRuntimeCandidate): Promise<WorkerApplication>;
  markApplied(candidate: ResolvedRuntimeCandidate): Promise<void>;
  markRejected(version: number, errorCode: string): Promise<void>;
  closeLoader?(): Promise<void>;
}

const EMPTY_COUNTERS = Object.freeze({
  canvas: 0,
  llm: 0,
  exchangeRate: 0,
  assetStaging: 0,
  assetPublishing: 0,
  imagePlanner: 0,
  imageGeneration: 0
});

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "runtime_configuration_invalid";
}

function failedCandidateVersion(error: unknown): number | undefined {
  const value = error && typeof error === "object" && "candidateVersion" in error
    ? (error as { candidateVersion?: unknown }).candidateVersion
    : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function closeAll(resources: ReadonlyArray<(() => Promise<void>) | undefined>): Promise<void> {
  const results = await Promise.allSettled(
    resources.filter((close): close is () => Promise<void> => Boolean(close)).map((close) => close())
  );
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "reloadable worker cleanup failed");
}

export function createReloadableWorkerApplication(
  input: ReloadableWorkerApplicationInput
): WorkerApplication {
  let current: WorkerApplication | undefined;
  let currentVersion: number | undefined;
  let rejectedVersion: number | undefined;
  let restorationAttempted = false;
  const retainedForCleanup = new Set<WorkerApplication>();
  let closePromise: Promise<void> | undefined;

  return {
    async run(runInput) {
      if (!restorationAttempted) {
        restorationAttempted = true;
        const applied = await input.loadAppliedCandidate?.();
        if (applied) {
          current = await input.build(applied);
          currentVersion = applied.version;
        }
      }

      let candidate: ResolvedRuntimeCandidate | undefined;
      try {
        candidate = await input.loadCandidate();
      } catch (error) {
        const version = failedCandidateVersion(error);
        if (version !== undefined && version !== rejectedVersion) {
          rejectedVersion = version;
          await input.markRejected(version, safeErrorCode(error));
        }
        if (!current) throw error;
        return current.run(runInput);
      }
      if (!candidate) {
        throw Object.assign(new Error("runtime configuration is unavailable"), {
          code: "runtime_configuration_missing"
        });
      }

      if (
        currentVersion === undefined ||
        (candidate.version > currentVersion && candidate.version !== rejectedVersion)
      ) {
        let next: WorkerApplication;
        try {
          next = await input.build(candidate);
        } catch (error) {
          rejectedVersion = candidate.version;
          await input.markRejected(candidate.version, safeErrorCode(error));
          if (!current) throw error;
          return current.run(runInput);
        }

        try {
          await input.markApplied(candidate);
        } catch (error) {
          try {
            await next.close();
          } catch {
            retainedForCleanup.add(next);
            throw error;
          }
          if (!current) throw error;
          return current.run(runInput);
        }

        const previous = current;
        current = next;
        currentVersion = candidate.version;
        rejectedVersion = undefined;
        if (previous) {
          retainedForCleanup.add(previous);
          try {
            await previous.close();
            retainedForCleanup.delete(previous);
          } catch (error) {
            throw error;
          }
        }
      }

      if (!current) {
        throw Object.assign(new Error("runtime configuration is unavailable"), {
          code: "runtime_configuration_missing"
        });
      }
      return current.run(runInput);
    },
    counters: () => current?.counters() ?? EMPTY_COUNTERS,
    close() {
      const owned = new Set(retainedForCleanup);
      if (current) owned.add(current);
      closePromise ??= closeAll([
        ...[...owned].map((application) => () => application.close()),
        input.closeLoader
      ]);
      return closePromise;
    }
  };
}
