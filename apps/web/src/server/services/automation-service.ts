import type { StartAutomationV1 } from "@tk/contracts/commands";

export interface RevisionVersionRepository {
  processingVersion(revisionId: string): Promise<number>;
}

export interface AutomationRunRepositoryPort {
  createOrReuseAndEnqueue(input: {
      revisionId: string;
      processingVersion: number;
      audit: {
        actorType: "operator";
        action: string;
        targetKind: string;
        payload: Record<string, unknown>;
      };
  }): Promise<{ runId: string; created: boolean }>;
}

export class AutomationService {
  constructor(
    private readonly revisions: RevisionVersionRepository,
    private readonly automationRuns: AutomationRunRepositoryPort
  ) {}

  async start(command: StartAutomationV1): Promise<{
    runs: Array<{ revisionId: string; runId: string; created: boolean }>;
  }> {
    const runs = [] as Array<{ revisionId: string; runId: string; created: boolean }>;
    for (const revisionId of command.revisionIds) {
        const processingVersion = await this.revisions.processingVersion(revisionId);
        const result = await this.automationRuns.createOrReuseAndEnqueue({
          revisionId,
          processingVersion,
          audit: {
            actorType: "operator",
            action: "start_automation",
            targetKind: "automation_run",
            payload: { revisionId }
          }
        });
        runs.push({ revisionId, ...result });
    }
    return { runs };
  }
}
